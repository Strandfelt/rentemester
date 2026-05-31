import type { Database } from "bun:sqlite";
import { postJournalEntry, type JournalPostResult } from "./ledger";
import { getInvoiceStatus } from "./invoice-payments";
import { insertAuditLog } from "./actor";
import { isValidIsoDate as looksLikeIsoDate, diffDays } from "./dates";
import { addDkk, cumulativeInterestDkk, roundDkk, subtractDkk } from "./money";

const RULE_ID = "DK-INVOICE-LATE-INTEREST-001";
const REGISTER_RULE_ID = "DK-INVOICE-LATE-INTEREST-REGISTER-001";
const BOOKKEEPING_RULE_ID = "DK-INVOICE-LATE-INTEREST-BOOKKEEPING-001";

export type CalculateInvoiceLateInterestInput = {
  invoiceDocumentId: number;
  asOfDate: string;
  referenceRatePercent: number;
};

export type CalculateInvoiceLateInterestResult = {
  ok: boolean;
  invoiceDocumentId?: number;
  invoiceNumber?: string;
  asOfDate?: string;
  effectiveDueDate?: string;
  overdueDays?: number;
  // The day this claim's interest starts accruing from: the latest existing
  // claim date, or the effective due date if there is none. Anchors the
  // incremental segment so a later claim never re-bills days already covered.
  interestFromDate?: string;
  // Days actually billed by THIS claim (interestFromDate → asOfDate). Equals
  // overdueDays for a first claim; the incremental window for a later one.
  claimableDays?: number;
  principalOpenBalance?: number;
  referenceRatePercent?: number;
  annualInterestRatePercent?: number;
  // The interest claimable NOW — the incremental amount for the period since the
  // last claim. For a first claim this equals the full overdue window. Computed
  // as totalInterestToDate minus what has already been claimed, so summing the
  // staged claims reproduces a single continuous calculation with no øre drift.
  accruedInterestAmount?: number;
  // Sum of interest already registered on this invoice up to the as-of date
  // (0 when none).
  priorClaimedInterest?: number;
  // Cumulative statutory interest accrued through the as-of date, rounded to øre
  // exactly once across all contiguous segments (no per-segment drift).
  totalInterestToDate?: number;
  // The amount by which immutable earlier claims already billed MORE than the
  // now-lawful cumulative — non-zero only when a back-dated balance reduction
  // retroactively lowered the principal under an already-issued claim. A signal
  // that a correcting credit may be due; never auto-applied. 0 in the normal case.
  overClaimedInterest?: number;
  appliedRules: string[];
  errors: string[];
};

export type RegisterInvoiceLateInterestInput = CalculateInvoiceLateInterestInput & {
  note?: string;
  // Actor attribution for the registration audit_log row (the post step already
  // threads these; the register step must too, or the row leaks the OS user).
  createdBy?: string;
  createdByProgram?: string;
};

export type RegisterInvoiceLateInterestResult = CalculateInvoiceLateInterestResult & {
  claimId?: number;
  claimDate?: string;
  claimOpenBalance?: number;
};

export type PostInvoiceLateInterestToLedgerInput = {
  invoiceDocumentId: number;
  claimId?: number;
  transactionDate?: string;
  receivableAccountNo?: string;
  interestIncomeAccountNo?: string;
  createdBy?: string;
  createdByProgram?: string;
};

export type PostInvoiceLateInterestToLedgerResult = JournalPostResult & {
  claimId?: number;
  invoiceDocumentId?: number;
  invoiceNumber?: string;
  claimDate?: string;
  accruedInterestAmount?: number;
  claimOpenBalance?: number;
};

export function calculateInvoiceLateInterest(db: Database, input: CalculateInvoiceLateInterestInput): CalculateInvoiceLateInterestResult {
  const errors: string[] = [];
  if (!Number.isInteger(input.invoiceDocumentId) || input.invoiceDocumentId <= 0) errors.push("invoiceDocumentId must be a positive integer");
  if (!looksLikeIsoDate(input.asOfDate)) errors.push("asOfDate must be YYYY-MM-DD");
  if (!Number.isFinite(input.referenceRatePercent)) errors.push("referenceRatePercent must be a finite number");
  if (errors.length > 0) return { ok: false, appliedRules: [RULE_ID], errors };

  const status = getInvoiceStatus(db, input.invoiceDocumentId, input.asOfDate);
  if (!status.ok) return { ok: false, appliedRules: [RULE_ID], errors: status.errors };

  const grossAmount = roundDkk(Number(status.grossAmount ?? 0));
  const overdueDays = Number(status.overdueDays ?? 0);
  const annualInterestRatePercent = roundDkk(addDkk(Number(input.referenceRatePercent), 8));
  const effectiveDueDate = status.effectiveDueDate;

  // Morarente accrues continuously, day by day, on the UNPAID principal from the
  // due date (renteloven § 3) at the reference rate + 8 pct (§ 5, stk. 1). It is
  // simple interest — there is no statutory rente-af-rente.
  //
  // The accrual is DATE-AWARE: the principal is the open balance *as of each day*,
  // reconstructed from the balance-changing events (payments, credit notes,
  // refunds, write-offs) and their effective dates. The overdue window is split
  // both by the existing claims (each carries its own reference rate) and by every
  // balance-change date, and the statutory interest is summed across all those
  // sub-segments and rounded to øre exactly ONCE (cumulativeInterestDkk) — so a
  // second claim re-bills no day an earlier one covered, partial payments lower the
  // later days' principal exactly, and staged claims never drift by accumulated øre.
  //
  // A new claim bills only totalInterestToDate − what has already been claimed. If
  // a back-dated balance reduction makes the now-lawful cumulative LOWER than what
  // immutable earlier claims already billed, the increment clamps to 0 (nothing new
  // is owed) and the excess is reported as overClaimedInterest — issuing a
  // correcting credit for the already-posted claim is an accounting decision, made
  // outside this deterministic calculation.
  const balanceEvents: Array<{ date: string; delta: number }> = [
    ...(status.payments ?? []).map((p) => ({ date: p.paymentDate, delta: -Number(p.amount) })),
    ...(status.creditNotes ?? []).map((c) => ({ date: c.issueDate ?? effectiveDueDate ?? input.asOfDate, delta: -Number(c.amount) })),
    ...(status.refunds ?? []).map((r) => ({ date: r.refundDate, delta: Number(r.amount) })),
    ...(status.badDebtWriteOffs ?? []).map((w) => ({ date: w.writeOffDate, delta: -Number(w.grossAmount) })),
  ].filter((e): e is { date: string; delta: number } => typeof e.date === "string");

  // Open principal balance as of a date: gross plus every balance event effective
  // on/before that date. Mirrors getInvoiceStatus's openBalance formula, but
  // date-aware (getInvoiceStatus itself sums all events regardless of date).
  const openBalanceAsOf = (asOf: string): number => {
    let balance = grossAmount;
    for (const event of balanceEvents) {
      if (event.date <= asOf) balance = addDkk(balance, event.delta);
    }
    return roundDkk(balance);
  };

  // Accrue one claim's window [from, to] at a single rate, split into sub-segments
  // at each balance-change date so every sub-segment uses the principal actually
  // outstanding during it.
  const sortedEventDates = [...new Set(balanceEvents.map((e) => e.date))].sort();
  const windowSegments = (
    from: string | undefined,
    to: string,
    annualRatePercent: number,
  ): Array<{ principalAmount: number; annualRatePercent: number; days: number }> => {
    if (!from || diffDays(from, to) <= 0) return [];
    const breakpoints = [from, ...sortedEventDates.filter((d) => d > from && d < to), to];
    const out: Array<{ principalAmount: number; annualRatePercent: number; days: number }> = [];
    for (let i = 0; i < breakpoints.length - 1; i++) {
      const start = breakpoints[i]!;
      const days = diffDays(start, breakpoints[i + 1]!);
      if (days <= 0) continue;
      const principalAmount = openBalanceAsOf(start);
      if (principalAmount > 0) out.push({ principalAmount, annualRatePercent, days });
    }
    return out;
  };

  // The principal as of the as-of date gates "is there anything to bill".
  const principalOpenBalance = openBalanceAsOf(input.asOfDate);

  const priorClaims = db
    .query(
      `SELECT claim_date, annual_interest_rate_percent, amount_dkk
       FROM invoice_interest_claims
       WHERE invoice_document_id = ?
       ORDER BY claim_date ASC, id ASC`,
    )
    .all(input.invoiceDocumentId) as Array<{
    claim_date: string;
    annual_interest_rate_percent: number;
    amount_dkk: number;
  }>;

  const lastClaimDate = priorClaims.length
    ? priorClaims[priorClaims.length - 1]!.claim_date
    : null;

  // This claim's incremental window anchors at the latest existing claim (over ALL
  // claims, so a later claim is never overlapped) or the due date. The reported
  // from-date never exceeds the as-of date: a backwards query bills nothing new.
  const anchor = effectiveDueDate
    ? lastClaimDate && lastClaimDate > effectiveDueDate
      ? lastClaimDate
      : effectiveDueDate
    : undefined;
  const interestFromDate = anchor && anchor > input.asOfDate ? input.asOfDate : anchor;
  const claimableDays =
    interestFromDate && principalOpenBalance > 0
      ? Math.max(0, diffDays(interestFromDate, input.asOfDate))
      : 0;

  // Build every sub-segment up to the as-of date: one claim-window per existing
  // claim (clamped so it never extends past the as-of date, at the claim's own
  // rate), plus the new increment window — each further split by balance-change
  // dates. priorClaimedInterest is what was actually billed in claims dated on/
  // before the as-of date — the baseline the new increment is measured against.
  const segments: Array<{ principalAmount: number; annualRatePercent: number; days: number }> = [];
  let windowStart = effectiveDueDate;
  let priorClaimedInterest = 0;
  for (const claim of priorClaims) {
    const windowEnd = claim.claim_date < input.asOfDate ? claim.claim_date : input.asOfDate;
    segments.push(...windowSegments(windowStart, windowEnd, Number(claim.annual_interest_rate_percent)));
    windowStart = claim.claim_date;
    if (claim.claim_date <= input.asOfDate) {
      priorClaimedInterest = addDkk(priorClaimedInterest, Number(claim.amount_dkk));
    }
  }
  if (claimableDays > 0) {
    segments.push(...windowSegments(interestFromDate, input.asOfDate, annualInterestRatePercent));
  }
  priorClaimedInterest = roundDkk(priorClaimedInterest);

  const totalInterestToDate = cumulativeInterestDkk(segments);
  // Claimable now = cumulative interest through the as-of date minus what has
  // already been billed up to that date, clamped to ≥ 0.
  const accruedInterestAmount =
    claimableDays > 0 && totalInterestToDate > priorClaimedInterest
      ? roundDkk(subtractDkk(totalInterestToDate, priorClaimedInterest))
      : 0;
  // When immutable earlier claims already billed MORE than the now-lawful
  // cumulative (e.g. a back-dated payment retroactively lowered the balance),
  // surface the excess so a correcting credit can be considered. Not auto-applied.
  const overClaimedInterest =
    priorClaimedInterest > totalInterestToDate
      ? roundDkk(subtractDkk(priorClaimedInterest, totalInterestToDate))
      : 0;

  return {
    ok: true,
    invoiceDocumentId: input.invoiceDocumentId,
    invoiceNumber: status.invoiceNumber,
    asOfDate: input.asOfDate,
    effectiveDueDate,
    overdueDays,
    interestFromDate,
    claimableDays,
    principalOpenBalance,
    referenceRatePercent: roundDkk(Number(input.referenceRatePercent)),
    annualInterestRatePercent,
    accruedInterestAmount,
    priorClaimedInterest,
    totalInterestToDate,
    overClaimedInterest,
    appliedRules: [RULE_ID],
    errors: [],
  };
}

export function registerInvoiceLateInterest(db: Database, input: RegisterInvoiceLateInterestInput): RegisterInvoiceLateInterestResult {
  // Concurrency note: the anchor (latest existing claim) is read inside
  // calculateInvoiceLateInterest and the new claim is inserted below in separate
  // statements. This assumes a single writer per company ledger — the supported
  // model (one MCP server / one CLI invocation at a time); bun:sqlite serialises
  // statements within a process. It is NOT safe against two *separate processes*
  // registering interest on the SAME invoice concurrently: both could read the
  // same anchor before either inserts and bill overlapping windows. The same is
  // true of the sibling reminder/compensation register paths; serialising all of
  // them (BEGIN IMMEDIATE) is a ledger-wide change, out of scope here.
  const calculation = calculateInvoiceLateInterest(db, input);
  if (!calculation.ok) return { ...calculation, appliedRules: [...new Set([...(calculation.appliedRules ?? []), REGISTER_RULE_ID])] };
  // Reject an exact duplicate (same as-of date AND reference rate) BEFORE the
  // positive-amount check below: re-registering the identical claim should
  // report "already registered" rather than the zero-increment "must be
  // positive" message it would otherwise hit (its incremental window is 0 days).
  const existing = db.query(
    `SELECT id FROM invoice_interest_claims WHERE invoice_document_id = ? AND claim_date = ? AND reference_rate_percent = ? LIMIT 1`
  ).get(input.invoiceDocumentId, input.asOfDate, roundDkk(Number(input.referenceRatePercent))) as { id: number } | null;
  if (existing) {
    return {
      ...calculation,
      ok: false,
      appliedRules: [RULE_ID, REGISTER_RULE_ID],
      errors: [`late interest for invoice ${input.invoiceDocumentId} is already registered for ${input.asOfDate} at reference rate ${roundDkk(Number(input.referenceRatePercent))}`],
    };
  }

  // accruedInterestAmount is the INCREMENTAL interest since the last claim (see
  // calculateInvoiceLateInterest). A non-positive increment means there is
  // nothing new to bill — the as-of date is on/before the last claim, or the
  // principal is settled. Because each claim only covers the days an earlier
  // claim has not, no open-claim guard is needed to prevent a double-charge:
  // staged claims (e.g. one per reminder) are both lawful and safe.
  if (!(Number(calculation.accruedInterestAmount ?? 0) > 0)) {
    return {
      ...calculation,
      ok: false,
      appliedRules: [...new Set([...(calculation.appliedRules ?? []), REGISTER_RULE_ID])],
      errors: ["late interest must be positive before it can be registered"],
    };
  }

  const inserted = db.query(
    `INSERT INTO invoice_interest_claims (
      invoice_document_id, claim_date, reference_rate_percent, annual_interest_rate_percent,
      overdue_days, principal_open_balance, amount_dkk, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id`
  ).get(
    input.invoiceDocumentId,
    input.asOfDate,
    roundDkk(Number(input.referenceRatePercent)),
    roundDkk(Number(calculation.annualInterestRatePercent)),
    // Store the days THIS claim covers (the incremental segment). amount_dkk is
    // the rounded-cumulative delta (see calculateInvoiceLateInterest), so it is
    // reproducible from the full claim sequence, not the single row in isolation.
    Number(calculation.claimableDays),
    roundDkk(Number(calculation.principalOpenBalance)),
    roundDkk(Number(calculation.accruedInterestAmount)),
    input.note ?? null,
  ) as { id: number };

  insertAuditLog(db, {
    eventType: "invoice_interest_register",
    entityType: "invoice_interest_claim",
    entityId: inserted.id,
    message: `Registered late interest ${roundDkk(Number(calculation.accruedInterestAmount))} on invoice ${calculation.invoiceNumber}`,
    createdBy: input.createdBy,
    createdByProgram: input.createdByProgram,
  });

  const statusAfter = getInvoiceStatus(db, input.invoiceDocumentId, input.asOfDate);
  return {
    ...calculation,
    ok: true,
    claimId: inserted.id,
    claimDate: input.asOfDate,
    claimOpenBalance: statusAfter.ok ? statusAfter.claimOpenBalance : undefined,
    appliedRules: [RULE_ID, REGISTER_RULE_ID],
    errors: [],
  };
}

export function postInvoiceLateInterestToLedger(db: Database, input: PostInvoiceLateInterestToLedgerInput): PostInvoiceLateInterestToLedgerResult {
  if (!Number.isInteger(input.invoiceDocumentId) || input.invoiceDocumentId <= 0) {
    return { ok: false, appliedRules: [BOOKKEEPING_RULE_ID], errors: ["invoiceDocumentId must be a positive integer"] };
  }

  // With no explicit claimId, post the OLDEST not-yet-posted claim (chronological
  // booking order). Now that staged multi-claim registration is allowed, the
  // default must skip already-posted claims, or it would re-select claim 1 and
  // refuse with "already posted" once it is booked. An explicit claimId selects
  // that claim regardless of posting state, so re-posting it still reports
  // "already posted".
  const claim = db.query(
    `SELECT c.id, c.invoice_document_id, c.claim_date, c.amount_dkk, d.invoice_no
     FROM invoice_interest_claims c
     JOIN documents d ON d.id = c.invoice_document_id
     LEFT JOIN invoice_interest_postings p ON p.interest_claim_id = c.id
     WHERE c.invoice_document_id = ?
       AND (? IS NULL OR c.id = ?)
       AND (? IS NOT NULL OR p.id IS NULL)
     ORDER BY c.claim_date ASC, c.id ASC
     LIMIT 1`
  ).get(
    input.invoiceDocumentId,
    input.claimId ?? null,
    input.claimId ?? null,
    input.claimId ?? null,
  ) as {
    id: number;
    invoice_document_id: number;
    claim_date: string;
    amount_dkk: number;
    invoice_no: string;
  } | null;

  if (!claim) {
    if (!input.claimId) {
      const anyClaim = db
        .query(`SELECT id FROM invoice_interest_claims WHERE invoice_document_id = ? LIMIT 1`)
        .get(input.invoiceDocumentId) as { id: number } | null;
      if (anyClaim) {
        return { ok: false, appliedRules: [BOOKKEEPING_RULE_ID], errors: [`all registered late-interest claims for invoice ${input.invoiceDocumentId} are already posted`] };
      }
    }
    return { ok: false, appliedRules: [BOOKKEEPING_RULE_ID], errors: [input.claimId ? `interest claim ${input.claimId} does not exist for invoice ${input.invoiceDocumentId}` : `invoice ${input.invoiceDocumentId} has no registered late-interest claim`] };
  }

  const existing = db.query(
    `SELECT p.id, p.journal_entry_id, j.entry_no
     FROM invoice_interest_postings p
     JOIN journal_entries j ON j.id = p.journal_entry_id
     WHERE p.interest_claim_id = ?`
  ).get(claim.id) as { id: number; journal_entry_id: number; entry_no: string } | null;

  if (existing) {
    return {
      ok: false,
      claimId: claim.id,
      invoiceDocumentId: claim.invoice_document_id,
      invoiceNumber: claim.invoice_no,
      claimDate: claim.claim_date,
      accruedInterestAmount: roundDkk(Number(claim.amount_dkk)),
      appliedRules: [BOOKKEEPING_RULE_ID],
      errors: [`interest claim ${claim.id} is already posted in journal entry ${existing.entry_no}`],
    };
  }

  const amount = roundDkk(Number(claim.amount_dkk));
  try {
    return db.transaction(() => {
      const journal = postJournalEntry(db, {
        transactionDate: input.transactionDate ?? claim.claim_date,
        text: `Late interest ${claim.invoice_no}`,
        documentId: claim.invoice_document_id,
        createdBy: input.createdBy,
        createdByProgram: input.createdByProgram,
        lines: [
          { accountNo: input.receivableAccountNo ?? "1100", debitAmount: amount, text: `Late-interest receivable ${claim.invoice_no}` },
          { accountNo: input.interestIncomeAccountNo ?? "1010", creditAmount: amount, text: `Late-interest income ${claim.invoice_no}` },
        ],
      });
      if (!journal.ok) {
        return { ...journal, claimId: claim.id, invoiceDocumentId: claim.invoice_document_id, invoiceNumber: claim.invoice_no, claimDate: claim.claim_date, accruedInterestAmount: amount, appliedRules: [...new Set([...(journal.appliedRules ?? []), BOOKKEEPING_RULE_ID])] };
      }

      db.run(
        `INSERT INTO invoice_interest_postings (interest_claim_id, journal_entry_id) VALUES (?, ?)`,
        claim.id,
        journal.entryId,
      );

      insertAuditLog(db, {
        eventType: "invoice_interest_post",
        entityType: "invoice_interest_claim",
        entityId: claim.id,
        message: `Posted late interest ${amount} for invoice ${claim.invoice_no} in journal entry ${journal.entryNo}`,
        createdBy: input.createdBy,
        createdByProgram: input.createdByProgram,
      });

      const statusAfter = getInvoiceStatus(db, claim.invoice_document_id, input.transactionDate ?? claim.claim_date);
      return {
        ...journal,
        claimId: claim.id,
        invoiceDocumentId: claim.invoice_document_id,
        invoiceNumber: claim.invoice_no,
        claimDate: claim.claim_date,
        accruedInterestAmount: amount,
        claimOpenBalance: statusAfter.ok ? statusAfter.claimOpenBalance : undefined,
        appliedRules: [...new Set([...(journal.appliedRules ?? []), BOOKKEEPING_RULE_ID])],
      };
    })();
  } catch (error) {
    return {
      ok: false,
      claimId: claim.id,
      invoiceDocumentId: claim.invoice_document_id,
      invoiceNumber: claim.invoice_no,
      claimDate: claim.claim_date,
      accruedInterestAmount: amount,
      appliedRules: [BOOKKEEPING_RULE_ID],
      errors: [String(error)],
    };
  }
}
