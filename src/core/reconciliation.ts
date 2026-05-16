import type { Database } from "bun:sqlite";

export type BankReconciliationReport = {
  ok: boolean;
  appliedRules: string[];
  periodStart: string;
  periodEnd: string;
  matchedCount: number;
  unmatchedCount: number;
  matchedAmountTotal: number;
  unmatchedAmountTotal: number;
  matched: Array<{
    bankTransactionId: number;
    transactionDate: string;
    text: string;
    amount: number;
    journalEntryId: number;
    journalEntryNo: string;
  }>;
  unmatched: Array<{
    bankTransactionId: number;
    transactionDate: string;
    text: string;
    amount: number;
    importBatchId: string | null;
  }>;
  errors: string[];
};

const RULE_ID = "DK-BOOKKEEPING-RECONCILIATION-001";

function looksLikeIsoDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function round2(value: number) {
  return Number(value.toFixed(2));
}

export function buildBankReconciliationReport(db: Database, periodStart: string, periodEnd: string): BankReconciliationReport {
  const errors: string[] = [];
  if (!looksLikeIsoDate(periodStart)) errors.push("periodStart must be YYYY-MM-DD");
  if (!looksLikeIsoDate(periodEnd)) errors.push("periodEnd must be YYYY-MM-DD");
  if (errors.length === 0 && periodStart > periodEnd) errors.push("periodStart must be before or equal to periodEnd");
  if (errors.length > 0) {
    return {
      ok: false,
      appliedRules: [RULE_ID],
      periodStart,
      periodEnd,
      matchedCount: 0,
      unmatchedCount: 0,
      matchedAmountTotal: 0,
      unmatchedAmountTotal: 0,
      matched: [],
      unmatched: [],
      errors,
    };
  }

  const rows = db.query(
    `SELECT bt.id as bank_transaction_id, bt.transaction_date, bt.text, bt.amount, bt.import_batch_id,
            je.id as journal_entry_id, je.entry_no
     FROM bank_transactions bt
     LEFT JOIN journal_entries je ON je.source_bank_transaction_id = bt.id
     WHERE bt.transaction_date >= ? AND bt.transaction_date <= ?
     ORDER BY bt.transaction_date ASC, bt.id ASC`
  ).all(periodStart, periodEnd) as Array<{
    bank_transaction_id: number;
    transaction_date: string;
    text: string;
    amount: number;
    import_batch_id: string | null;
    journal_entry_id: number | null;
    entry_no: string | null;
  }>;

  const matched: BankReconciliationReport["matched"] = [];
  const unmatched: BankReconciliationReport["unmatched"] = [];
  let matchedAmountTotal = 0;
  let unmatchedAmountTotal = 0;

  for (const row of rows) {
    const amount = round2(Number(row.amount));
    if (row.journal_entry_id) {
      matched.push({
        bankTransactionId: row.bank_transaction_id,
        transactionDate: row.transaction_date,
        text: row.text,
        amount,
        journalEntryId: row.journal_entry_id,
        journalEntryNo: row.entry_no!,
      });
      matchedAmountTotal += amount;
    } else {
      unmatched.push({
        bankTransactionId: row.bank_transaction_id,
        transactionDate: row.transaction_date,
        text: row.text,
        amount,
        importBatchId: row.import_batch_id,
      });
      unmatchedAmountTotal += amount;
    }
  }

  return {
    ok: true,
    appliedRules: [RULE_ID],
    periodStart,
    periodEnd,
    matchedCount: matched.length,
    unmatchedCount: unmatched.length,
    matchedAmountTotal: round2(matchedAmountTotal),
    unmatchedAmountTotal: round2(unmatchedAmountTotal),
    matched,
    unmatched,
    errors: [],
  };
}
