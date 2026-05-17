import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

export type JournalLineInput = {
  accountNo: string;
  debitAmount?: number;
  creditAmount?: number;
  vatCode?: string;
  text?: string;
};

export type JournalEntryInput = {
  transactionDate: string;
  text: string;
  documentId?: number;
  sourceBankTransactionId?: number;
  currency?: string;
  amountForeign?: number;
  amountDkk?: number;
  fxRateToDkk?: number;
  createdBy?: string;
  createdByProgram?: string;
  lines: JournalLineInput[];
};

export type JournalPostResult = {
  ok: boolean;
  entryId?: number;
  entryNo?: string;
  entryHash?: string;
  appliedRules: string[];
  errors: string[];
};

export type JournalReverseResult = JournalPostResult & {
  originalEntryId?: number;
};

const LEDGER_RULES = {
  BALANCED: "DK-BOOKKEEPING-BALANCED-001",
  APPEND_ONLY: "DK-BOOKKEEPING-APPEND-ONLY-001",
  REVERSAL: "DK-BOOKKEEPING-REVERSAL-001",
  DOCUMENT: "DK-BOOKKEEPING-DOCUMENT-001",
  FX: "DK-BOOKKEEPING-FX-001",
} as const;

export function seedAccounts(db: Database) {
  const rows = [
    ["1000", "Omsætning, ydelser", "income", "credit", null],
    ["1010", "Gebyr- og kompensationsindtægter", "income", "credit", null],
    ["1100", "Debitorer", "asset", "debit", null],
    ["1200", "Salgsmoms", "vat", "credit", null],
    ["2000", "Bank", "asset", "debit", null],
    ["3000", "Software og SaaS", "expense", "debit", "DK_PURCHASE_25"],
    ["3010", "AI-værktøjer", "expense", "debit", "EU_SERVICE_REVERSE_CHARGE"],
    ["3020", "Hosting og cloud", "expense", "debit", "EU_SERVICE_REVERSE_CHARGE"],
    ["3050", "Rejse og transport", "expense", "debit", "DK_PURCHASE_25"],
    ["3070", "Repræsentation", "expense", "debit", "REPRESENTATION_SPECIAL"],
    ["3080", "Tab på debitorer", "expense", "debit", "DK_BAD_DEBT_25"],
    ["3120", "Hardware og udstyr", "expense", "debit", "DK_PURCHASE_25"],
    ["4000", "Købsmoms", "vat", "debit", null],
    ["4500", "Momsafregning", "liability", "credit", null],
    ["5000", "Egenkapital", "equity", "credit", null]
  ];
  const insert = db.prepare("INSERT OR IGNORE INTO accounts (account_no,name,type,normal_balance,default_vat_code) VALUES (?,?,?,?,?)");
  db.transaction(() => rows.forEach((r) => insert.run(...r)))();
}

export function nextEntryNo(db: Database) {
  const row = db.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number };
  return `${new Date().getFullYear()}-${String(row.n + 1).padStart(5, "0")}`;
}

export function previousHash(db: Database) {
  const row = db.query("SELECT entry_hash FROM journal_entries ORDER BY id DESC LIMIT 1").get() as { entry_hash: string } | null;
  return row?.entry_hash ?? "GENESIS";
}

export function hashEntry(data: unknown, prev: string) {
  return createHash("sha256").update(JSON.stringify(data)).update(prev).digest("hex");
}

function looksLikeIsoDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function normalizeAmount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
}

function canonicalEntryData(entry: any, lines: any[]) {
  return {
    entry_no: entry.entry_no,
    transaction_date: entry.transaction_date,
    text: entry.text,
    source_bank_transaction_id: entry.source_bank_transaction_id ?? null,
    document_id: entry.document_id ?? null,
    currency: entry.currency ?? 'DKK',
    amount_foreign: entry.amount_foreign ?? null,
    amount_dkk: entry.amount_dkk ?? null,
    fx_rate_to_dkk: entry.fx_rate_to_dkk ?? null,
    rule_version: entry.rule_version,
    created_by: entry.created_by,
    created_by_program: entry.created_by_program,
    status: entry.status,
    reversal_of_entry_id: entry.reversal_of_entry_id ?? null,
    lines: lines.map((line) => ({
      account_no: line.account_no,
      debit_amount: normalizeAmount(line.debit_amount),
      credit_amount: normalizeAmount(line.credit_amount),
      vat_code: line.vat_code ?? null,
      text: line.text ?? null,
    })),
  };
}

function accountMap(db: Database) {
  const rows = db.query("SELECT id, account_no, type, active FROM accounts").all() as Array<{ id: number; account_no: string; type: string; active: number }>;
  return new Map(rows.map((row) => [row.account_no, row]));
}

export function validateJournalEntry(db: Database, payload: JournalEntryInput) {
  const errors: string[] = [];
  const appliedRules = [LEDGER_RULES.BALANCED, LEDGER_RULES.APPEND_ONLY];
  const lines = payload.lines ?? [];
  const currency = (payload.currency ?? 'DKK').trim().toUpperCase();

  if (!looksLikeIsoDate(payload.transactionDate)) errors.push("transactionDate must be present in YYYY-MM-DD format");
  if (typeof payload.text !== "string" || payload.text.trim().length === 0) errors.push("text is required");
  if (!Array.isArray(lines) || lines.length < 2) errors.push("at least two journal lines are required");
  if (currency.length !== 3) errors.push("currency must be a 3-letter ISO code when present");

  const accounts = accountMap(db);
  let debitSum = 0;
  let creditSum = 0;
  let requiresDocument = false;

  lines.forEach((line, idx) => {
    const debit = normalizeAmount(line.debitAmount);
    const credit = normalizeAmount(line.creditAmount);
    if (!line.accountNo || !accounts.has(line.accountNo)) {
      errors.push(`lines[${idx}].accountNo must reference an existing account`);
      return;
    }
    const account = accounts.get(line.accountNo)!;
    if (!account.active) errors.push(`lines[${idx}].accountNo refers to an inactive account`);
    if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
      errors.push(`lines[${idx}] must have either debitAmount or creditAmount`);
    }
    debitSum += debit;
    creditSum += credit;
    if (account.type === "expense" || account.type === "income") requiresDocument = true;
  });

  if (normalizeAmount(debitSum) !== normalizeAmount(creditSum)) {
    errors.push(`journal entry must balance: debit ${normalizeAmount(debitSum)} != credit ${normalizeAmount(creditSum)}`);
  }

  if (currency !== 'DKK') {
    appliedRules.push(LEDGER_RULES.FX);
    const amountForeign = normalizeAmount(payload.amountForeign);
    const amountDkk = normalizeAmount(payload.amountDkk);
    const fxRateToDkk = typeof payload.fxRateToDkk === 'number' && Number.isFinite(payload.fxRateToDkk) ? Number(payload.fxRateToDkk.toFixed(6)) : NaN;
    if (!(amountForeign > 0)) errors.push("amountForeign must be positive for non-DKK journal entries");
    if (!(amountDkk > 0)) errors.push("amountDkk must be positive for non-DKK journal entries");
    if (!(fxRateToDkk > 0)) errors.push("fxRateToDkk must be positive for non-DKK journal entries");
    if (amountForeign > 0 && fxRateToDkk > 0) {
      const expectedAmountDkk = Number((amountForeign * fxRateToDkk).toFixed(2));
      if (amountDkk !== expectedAmountDkk) errors.push(`amountDkk must equal amountForeign * fxRateToDkk (${expectedAmountDkk})`);
    }
  }

  if (requiresDocument) {
    appliedRules.push(LEDGER_RULES.DOCUMENT);
    if (!payload.documentId) {
      errors.push("documentId is required when posting expense or income lines");
    } else {
      const doc = db.query("SELECT id FROM documents WHERE id = ?").get(payload.documentId) as { id: number } | null;
      if (!doc) errors.push(`documentId ${payload.documentId} does not exist`);
    }
  }

  if (payload.sourceBankTransactionId) {
    const bank = db.query("SELECT id FROM bank_transactions WHERE id = ?").get(payload.sourceBankTransactionId) as { id: number } | null;
    if (!bank) errors.push(`sourceBankTransactionId ${payload.sourceBankTransactionId} does not exist`);
  }

  return { ok: errors.length === 0, appliedRules, errors };
}

export function postJournalEntry(db: Database, payload: JournalEntryInput): JournalPostResult {
  const validation = validateJournalEntry(db, payload);
  if (!validation.ok) return { ok: false, appliedRules: validation.appliedRules, errors: validation.errors };

  const accounts = accountMap(db);
  const entryNo = nextEntryNo(db);
  const prevHash = previousHash(db);

  const result = db.transaction(() => {
    const canonicalLines = payload.lines.map((line) => ({
      account_no: line.accountNo,
      debit_amount: normalizeAmount(line.debitAmount),
      credit_amount: normalizeAmount(line.creditAmount),
      vat_code: line.vatCode ?? null,
      text: line.text ?? null,
    }));
    const entryDraft = {
      entry_no: entryNo,
      transaction_date: payload.transactionDate,
      text: payload.text,
      source_bank_transaction_id: payload.sourceBankTransactionId ?? null,
      document_id: payload.documentId ?? null,
      currency: (payload.currency ?? 'DKK').trim().toUpperCase(),
      amount_foreign: payload.amountForeign ?? null,
      amount_dkk: payload.amountDkk ?? null,
      fx_rate_to_dkk: payload.fxRateToDkk ?? null,
      rule_version: 'dk-v0.0.1',
      created_by: payload.createdBy ?? 'system',
      created_by_program: payload.createdByProgram ?? 'rentemester',
      status: 'posted',
      reversal_of_entry_id: null,
    };
    const entryHash = hashEntry(canonicalEntryData(entryDraft, canonicalLines), prevHash);

    const insertEntry = db.query(
      `INSERT INTO journal_entries (
        entry_no, transaction_date, text, source_bank_transaction_id, document_id,
        currency, amount_foreign, amount_dkk, fx_rate_to_dkk,
        rule_version, created_by, created_by_program, status, previous_hash, entry_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dk-v0.0.1', ?, ?, 'posted', ?, ?)
      RETURNING id, entry_no`
    );

    const entry = insertEntry.get(
      entryNo,
      payload.transactionDate,
      payload.text,
      payload.sourceBankTransactionId ?? null,
      payload.documentId ?? null,
      (payload.currency ?? 'DKK').trim().toUpperCase(),
      payload.amountForeign ?? null,
      payload.amountDkk ?? null,
      payload.fxRateToDkk ?? null,
      payload.createdBy ?? 'system',
      payload.createdByProgram ?? 'rentemester',
      prevHash,
      entryHash,
    ) as any;

    const insertLine = db.prepare(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit_amount, credit_amount, vat_code, currency, text)
       VALUES (?, ?, ?, ?, ?, 'DKK', ?)`
    );

    canonicalLines.forEach((line) => {
      const account = accounts.get(line.account_no)!;
      insertLine.run(entry.id, account.id, line.debit_amount, line.credit_amount, line.vat_code, line.text);
    });

    db.run(
      "INSERT INTO audit_log (event_type, entity_type, entity_id, message) VALUES ('journal_post', 'journal_entry', ?, ?)",
      String(entry.id),
      `Posted journal entry ${entry.entry_no}`
    );

    return { entryId: entry.id, entryNo: entry.entry_no, entryHash };
  })();

  return { ok: true, appliedRules: validation.appliedRules, errors: [], ...result };
}

export function reverseJournalEntry(db: Database, input: { entryId: number; transactionDate: string; reason: string; createdBy?: string; createdByProgram?: string; }): JournalReverseResult {
  const appliedRules = [LEDGER_RULES.APPEND_ONLY, LEDGER_RULES.REVERSAL];
  const errors: string[] = [];

  if (!Number.isInteger(input.entryId) || input.entryId <= 0) errors.push("entryId must be a positive integer");
  if (!looksLikeIsoDate(input.transactionDate)) errors.push("transactionDate must be present in YYYY-MM-DD format");
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) errors.push("reason is required");
  if (errors.length > 0) return { ok: false, appliedRules, errors };

  const original = db.query(
    `SELECT id, entry_no, transaction_date, text, source_bank_transaction_id, document_id, currency, amount_foreign, amount_dkk, fx_rate_to_dkk, rule_version, created_by, created_by_program, status, reversal_of_entry_id
     FROM journal_entries WHERE id = ?`
  ).get(input.entryId) as any | null;
  if (!original) return { ok: false, appliedRules, errors: [`journal entry ${input.entryId} does not exist`] };
  if (original.reversal_of_entry_id != null) return { ok: false, appliedRules, errors: [`journal entry ${input.entryId} is already a reversal entry`] };

  const existingReversal = db.query("SELECT id, entry_no FROM journal_entries WHERE reversal_of_entry_id = ? LIMIT 1").get(input.entryId) as { id: number; entry_no: string } | null;
  if (existingReversal) {
    return { ok: false, appliedRules, errors: [`journal entry ${input.entryId} already has reversal ${existingReversal.entry_no}`] };
  }

  const originalLines = db.query(
    `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code, jl.text
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id
     WHERE jl.journal_entry_id = ?
     ORDER BY jl.id ASC`
  ).all(input.entryId) as any[];
  if (originalLines.length === 0) {
    return { ok: false, appliedRules, errors: [`journal entry ${input.entryId} has no lines to reverse`] };
  }

  const reversalPayload: JournalEntryInput = {
    transactionDate: input.transactionDate,
    text: `Reversal of ${original.entry_no}: ${input.reason.trim()}`,
    documentId: original.document_id ?? undefined,
    sourceBankTransactionId: original.source_bank_transaction_id ?? undefined,
    currency: original.currency ?? 'DKK',
    amountForeign: original.amount_foreign ?? undefined,
    amountDkk: original.amount_dkk ?? undefined,
    fxRateToDkk: original.fx_rate_to_dkk ?? undefined,
    createdBy: input.createdBy ?? 'system',
    createdByProgram: input.createdByProgram ?? 'rentemester',
    lines: originalLines.map((line) => ({
      accountNo: line.account_no,
      debitAmount: normalizeAmount(line.credit_amount) || undefined,
      creditAmount: normalizeAmount(line.debit_amount) || undefined,
      vatCode: line.vat_code ?? undefined,
      text: line.text ? `REVERSAL: ${line.text}` : `REVERSAL of ${original.entry_no}`,
    })),
  };

  const validation = validateJournalEntry(db, reversalPayload);
  if (!validation.ok) return { ok: false, appliedRules: [...new Set([...appliedRules, ...validation.appliedRules])], errors: validation.errors };

  const accounts = accountMap(db);
  const entryNo = nextEntryNo(db);
  const prevHash = previousHash(db);

  const result = db.transaction(() => {
    const canonicalLines = reversalPayload.lines.map((line) => ({
      account_no: line.accountNo,
      debit_amount: normalizeAmount(line.debitAmount),
      credit_amount: normalizeAmount(line.creditAmount),
      vat_code: line.vatCode ?? null,
      text: line.text ?? null,
    }));
    const entryDraft = {
      entry_no: entryNo,
      transaction_date: reversalPayload.transactionDate,
      text: reversalPayload.text,
      source_bank_transaction_id: reversalPayload.sourceBankTransactionId ?? null,
      document_id: reversalPayload.documentId ?? null,
      currency: (reversalPayload.currency ?? 'DKK').trim().toUpperCase(),
      amount_foreign: reversalPayload.amountForeign ?? null,
      amount_dkk: reversalPayload.amountDkk ?? null,
      fx_rate_to_dkk: reversalPayload.fxRateToDkk ?? null,
      rule_version: 'dk-v0.0.1',
      created_by: reversalPayload.createdBy ?? 'system',
      created_by_program: reversalPayload.createdByProgram ?? 'rentemester',
      status: 'reversed',
      reversal_of_entry_id: original.id,
    };
    const entryHash = hashEntry(canonicalEntryData(entryDraft, canonicalLines), prevHash);

    const entry = db.query(
      `INSERT INTO journal_entries (
        entry_no, transaction_date, text, source_bank_transaction_id, document_id,
        currency, amount_foreign, amount_dkk, fx_rate_to_dkk,
        rule_version, created_by, created_by_program, status, reversal_of_entry_id, previous_hash, entry_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dk-v0.0.1', ?, ?, 'reversed', ?, ?, ?)
      RETURNING id, entry_no`
    ).get(
      entryNo,
      reversalPayload.transactionDate,
      reversalPayload.text,
      reversalPayload.sourceBankTransactionId ?? null,
      reversalPayload.documentId ?? null,
      (reversalPayload.currency ?? 'DKK').trim().toUpperCase(),
      reversalPayload.amountForeign ?? null,
      reversalPayload.amountDkk ?? null,
      reversalPayload.fxRateToDkk ?? null,
      reversalPayload.createdBy ?? 'system',
      reversalPayload.createdByProgram ?? 'rentemester',
      original.id,
      prevHash,
      entryHash,
    ) as any;

    const insertLine = db.prepare(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit_amount, credit_amount, vat_code, currency, text)
       VALUES (?, ?, ?, ?, ?, 'DKK', ?)`
    );
    canonicalLines.forEach((line) => {
      const account = accounts.get(line.account_no)!;
      insertLine.run(entry.id, account.id, line.debit_amount, line.credit_amount, line.vat_code, line.text);
    });

    db.run(
      "INSERT INTO audit_log (event_type, entity_type, entity_id, message) VALUES ('journal_reverse', 'journal_entry', ?, ?)",
      String(entry.id),
      `Reversed journal entry ${original.entry_no} with ${entry.entry_no}`
    );

    return { entryId: entry.id, entryNo: entry.entry_no, entryHash };
  })();

  return { ok: true, originalEntryId: original.id, appliedRules: [...new Set([...appliedRules, ...validation.appliedRules])], errors: [], ...result };
}

export function verifyAuditChain(db: Database) {
  const entries = db.query("SELECT id, entry_no, transaction_date, text, source_bank_transaction_id, document_id, currency, amount_foreign, amount_dkk, fx_rate_to_dkk, rule_version, created_by, created_by_program, status, reversal_of_entry_id, previous_hash, entry_hash FROM journal_entries ORDER BY id ASC").all() as any[];
  let prev = "GENESIS";
  const errors: string[] = [];
  for (const e of entries) {
    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code, jl.text
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ?
       ORDER BY jl.id ASC`
    ).all(e.id) as any[];
    const expected = hashEntry(canonicalEntryData(e, lines), prev);
    if (e.previous_hash !== prev) errors.push(`${e.entry_no}: previous_hash mismatch`);
    if (e.entry_hash !== expected) errors.push(`${e.entry_no}: entry_hash mismatch`);
    prev = e.entry_hash;
  }
  return { ok: errors.length === 0, entries: entries.length, errors };
}
