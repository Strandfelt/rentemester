import type { Database } from "bun:sqlite";
import { getCompanySettings } from "./company";
import { fiscalYearForDate } from "./fiscal-year";
import { currentUtcIsoDate } from "./sequences";
import { isValidIsoDate } from "./dates";

export type RetentionStatusRow = {
  table: "documents" | "journal_entries" | "bank_transactions";
  total: number;
  expired: number;
  nextExpiry: string | null;
  oldestExpired: string | null;
};

export type RetentionStatusReport = {
  ok: boolean;
  asOf: string;
  appliedRules: string[];
  rows: RetentionStatusRow[];
  errors: string[];
};

const RULE_ID = "DK-BOOKKEEPING-RETENTION-001";

export function retainUntilForDate(db: Database, dateText: string) {
  if (!isValidIsoDate(dateText)) throw new Error(`invalid ISO date: ${dateText}`);
  const company = getCompanySettings(db);
  const fiscalYear = fiscalYearForDate(dateText, company.fiscalYearStartMonth, company.fiscalYearLabelStrategy);
  return `${Number(fiscalYear.end.slice(0, 4)) + 5}${fiscalYear.end.slice(4)}`;
}

function backfillTableRetention(db: Database, table: "documents" | "journal_entries" | "bank_transactions") {
  if (table === "documents") {
    const rows = db.query(`SELECT id, COALESCE(invoice_date, substr(upload_datetime, 1, 10)) AS basis_date FROM documents WHERE retain_until IS NULL`).all() as Array<{ id: number; basis_date: string | null }>;
    const update = db.prepare("UPDATE documents SET retain_until = ? WHERE id = ?");
    for (const row of rows) {
      if (!row.basis_date || !isValidIsoDate(row.basis_date)) continue;
      update.run(retainUntilForDate(db, row.basis_date), row.id);
    }
  }
  if (table === "journal_entries") {
    const rows = db.query(`SELECT id, transaction_date FROM journal_entries WHERE retain_until IS NULL`).all() as Array<{ id: number; transaction_date: string | null }>;
    const update = db.prepare("UPDATE journal_entries SET retain_until = ? WHERE id = ?");
    for (const row of rows) {
      if (!row.transaction_date || !isValidIsoDate(row.transaction_date)) continue;
      update.run(retainUntilForDate(db, row.transaction_date), row.id);
    }
  }
  if (table === "bank_transactions") {
    const rows = db.query(`SELECT id, COALESCE(booking_date, transaction_date) AS basis_date FROM bank_transactions WHERE retain_until IS NULL`).all() as Array<{ id: number; basis_date: string | null }>;
    const update = db.prepare("UPDATE bank_transactions SET retain_until = ? WHERE id = ?");
    for (const row of rows) {
      if (!row.basis_date || !isValidIsoDate(row.basis_date)) continue;
      update.run(retainUntilForDate(db, row.basis_date), row.id);
    }
  }
}

export function backfillRetentionDeadlines(db: Database) {
  backfillTableRetention(db, "documents");
  backfillTableRetention(db, "journal_entries");
  backfillTableRetention(db, "bank_transactions");
}

export function buildRetentionStatusReport(db: Database, asOf = currentUtcIsoDate(db)): RetentionStatusReport {
  if (!isValidIsoDate(asOf)) return { ok: false, asOf, appliedRules: [RULE_ID], rows: [], errors: ["asOf must be YYYY-MM-DD"] };

  const summarize = (table: RetentionStatusRow["table"]) => {
    const row = db.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN retain_until IS NOT NULL AND retain_until < ? THEN 1 ELSE 0 END) AS expired,
              MIN(CASE WHEN retain_until IS NOT NULL AND retain_until >= ? THEN retain_until END) AS next_expiry,
              MIN(CASE WHEN retain_until IS NOT NULL AND retain_until < ? THEN retain_until END) AS oldest_expired
         FROM ${table}`
    ).get(asOf, asOf, asOf) as { total: number; expired: number | null; next_expiry: string | null; oldest_expired: string | null };
    return {
      table,
      total: Number(row.total ?? 0),
      expired: Number(row.expired ?? 0),
      nextExpiry: row.next_expiry ?? null,
      oldestExpired: row.oldest_expired ?? null,
    } satisfies RetentionStatusRow;
  };

  return {
    ok: true,
    asOf,
    appliedRules: [RULE_ID],
    rows: [summarize("documents"), summarize("journal_entries"), summarize("bank_transactions")],
    errors: [],
  };
}
