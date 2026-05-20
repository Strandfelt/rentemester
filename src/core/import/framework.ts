// Import framework — maps a normalised `ImportSource` onto the primobalance.
// Issue #185.
//
// `runImport` is the parser-agnostic engine. A per-system parser (implementing
// the `SourceParser` contract in ./types.ts) produces an `ImportSource`;
// `runImport` validates it and lands it on the #179 primobalance target by
// calling `postOpeningBalance`. It never reimplements opening-balance logic —
// the hash chain, append-only protection and audit log are inherited for free.
//
// Validation done HERE (before postOpeningBalance is even called):
//  - cut-over date present and well-formed
//  - at least one opening-balance line
//  - every opening-balance line references an account in the source's chart
//  - no line carries both a debit AND a credit amount
//  - the opening balances balance (sum debit == sum credit, in øre)
//
// postOpeningBalance then re-validates against the LIVE chart of accounts and
// owns idempotency (one primobalance per company). Failing fast here gives a
// clear, source-shaped error; postOpeningBalance is the backstop.

import type { Database } from "bun:sqlite";
import { postOpeningBalance } from "../opening-balance";
import { isValidIsoDate } from "../dates";
import { toOre } from "../money";
import type { ImportOptions, ImportResult, ImportSource } from "./types";

const IMPORT_RULE = "DK-BOOKKEEPING-BALANCED-001";

/**
 * Validates and posts a normalised `ImportSource` as the company's
 * primobalance. Pure with respect to its inputs and deterministic: the same
 * `ImportSource` always produces the same `auditTrail` and (on a fresh
 * company) the same `entryNo`.
 */
export function runImport(
  db: Database,
  source: ImportSource,
  options: ImportOptions = {},
): ImportResult {
  const errors: string[] = [];
  const auditTrail: string[] = [];
  const sourceSystem =
    typeof source?.sourceSystem === "string" && source.sourceSystem.trim().length > 0
      ? source.sourceSystem.trim()
      : "unknown";

  const fail = (extra: string[] = []): ImportResult => ({
    ok: false,
    sourceSystem,
    cutOverDate: typeof source?.cutOverDate === "string" ? source.cutOverDate.trim() : undefined,
    openingBalanceLineCount: Array.isArray(source?.openingBalances)
      ? source.openingBalances.length
      : 0,
    historicalEntriesSkipped: Array.isArray(source?.historicalEntries)
      ? source.historicalEntries.length
      : 0,
    auditTrail,
    appliedRules: [IMPORT_RULE],
    errors: [...errors, ...extra],
  });

  auditTrail.push(`Import started from source system '${sourceSystem}'`);

  // --- cut-over date -------------------------------------------------------
  const cutOverDate = typeof source?.cutOverDate === "string" ? source.cutOverDate.trim() : "";
  if (!isValidIsoDate(cutOverDate)) {
    errors.push("cut-over date must be present in YYYY-MM-DD format");
  } else {
    auditTrail.push(`Cut-over date is ${cutOverDate}`);
  }

  // --- chart of accounts ---------------------------------------------------
  const chart = Array.isArray(source?.chartOfAccounts) ? source.chartOfAccounts : [];
  const chartAccountNos = new Set(
    chart
      .map((a) => (typeof a?.accountNo === "string" ? a.accountNo.trim() : ""))
      .filter((a) => a.length > 0),
  );
  const chartNames = new Map(
    chart
      .filter((a) => typeof a?.accountNo === "string" && a.accountNo.trim().length > 0)
      .map((a) => [a.accountNo.trim(), typeof a.name === "string" ? a.name.trim() : ""]),
  );
  auditTrail.push(`Source chart of accounts has ${chartAccountNos.size} account(s)`);

  // --- opening balances ----------------------------------------------------
  const openingBalances = Array.isArray(source?.openingBalances) ? source.openingBalances : [];
  if (openingBalances.length === 0) {
    errors.push("import source has no opening balances to post");
  }

  let debitOre = 0n;
  let creditOre = 0n;
  for (let i = 0; i < openingBalances.length; i += 1) {
    const line = openingBalances[i]!;
    const accountNo = typeof line.accountNo === "string" ? line.accountNo.trim() : "";
    if (!accountNo) {
      errors.push(`openingBalances[${i}] is missing an accountNo`);
      continue;
    }
    if (chartAccountNos.size > 0 && !chartAccountNos.has(accountNo)) {
      errors.push(
        `openingBalances[${i}] references account '${accountNo}' which is not in the source chart of accounts`,
      );
    }
    const hasDebit = typeof line.debitAmount === "number" && Number.isFinite(line.debitAmount);
    const hasCredit = typeof line.creditAmount === "number" && Number.isFinite(line.creditAmount);
    if (hasDebit && hasCredit && line.debitAmount! !== 0 && line.creditAmount! !== 0) {
      errors.push(
        `openingBalances[${i}] (account '${accountNo}') carries both a debit and a credit amount`,
      );
    }
    if (!hasDebit && !hasCredit) {
      errors.push(`openingBalances[${i}] (account '${accountNo}') has neither a debit nor a credit amount`);
    }
    debitOre += toOre(hasDebit ? line.debitAmount! : 0);
    creditOre += toOre(hasCredit ? line.creditAmount! : 0);
  }

  if (openingBalances.length > 0 && debitOre !== creditOre) {
    errors.push(
      `import source does not balance: opening-balance debits != credits (${debitOre} != ${creditOre} øre)`,
    );
  }

  // Historical entries are accepted in the IR but intentionally not posted by
  // the current framework — opening balances are the supported target.
  const historicalEntries = Array.isArray(source?.historicalEntries)
    ? source.historicalEntries
    : [];
  if (historicalEntries.length > 0) {
    auditTrail.push(
      `${historicalEntries.length} historical entr${historicalEntries.length === 1 ? "y" : "ies"} present in source — not posted (opening balances are the import target)`,
    );
  }

  if (errors.length > 0) {
    auditTrail.push(`Validation failed with ${errors.length} error(s) — nothing posted`);
    return fail();
  }

  auditTrail.push(
    `Validated ${openingBalances.length} opening-balance line(s); balanced at ${debitOre} øre`,
  );

  // --- map onto the #179 primobalance target ------------------------------
  // Deterministic ordering: opening-balance lines are posted in the order the
  // parser produced them, so the resulting journal entry is reproducible.
  const note =
    typeof source.note === "string" && source.note.trim().length > 0
      ? `Import fra ${sourceSystem} — ${source.note.trim()}`
      : `Import fra ${sourceSystem}`;

  const result = postOpeningBalance(db, {
    cutOverDate,
    note,
    createdBy: options.createdBy,
    createdByProgram: options.createdByProgram ?? "rentemester-import",
    lines: openingBalances.map((line) => {
      const accountNo = line.accountNo.trim();
      return {
        accountNo,
        debitAmount: line.debitAmount,
        creditAmount: line.creditAmount,
        text:
          typeof line.text === "string" && line.text.trim().length > 0
            ? line.text.trim()
            : chartNames.get(accountNo) || `Primobalance ${accountNo}`,
      };
    }),
  });

  if (!result.ok || result.entryId == null || result.entryNo == null) {
    auditTrail.push("postOpeningBalance rejected the primobalance — nothing posted");
    return {
      ok: false,
      sourceSystem,
      cutOverDate,
      openingBalanceLineCount: openingBalances.length,
      historicalEntriesSkipped: historicalEntries.length,
      auditTrail,
      appliedRules: [...new Set([IMPORT_RULE, ...result.appliedRules])],
      errors: result.errors,
    };
  }

  auditTrail.push(`Posted primobalance as journal entry ${result.entryNo}`);

  return {
    ok: true,
    sourceSystem,
    cutOverDate,
    entryId: result.entryId,
    entryNo: result.entryNo,
    entryHash: result.entryHash,
    openingBalanceLineCount: openingBalances.length,
    historicalEntriesSkipped: historicalEntries.length,
    auditTrail,
    appliedRules: [...new Set([IMPORT_RULE, ...result.appliedRules])],
    errors: [],
  };
}
