import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

function hasColumn(db: Database, table: string, column: string) {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((col) => col.name === column);
}

export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return db;
}

export function migrate(db: Database) {
  const schema = readFileSync(join(import.meta.dir, "../../src/core/schema.sql"), "utf8");
  db.exec(schema);
  if (!hasColumn(db, "bank_transactions", "amount_dkk")) db.exec("ALTER TABLE bank_transactions ADD COLUMN amount_dkk NUMERIC;");
  if (!hasColumn(db, "bank_transactions", "fx_rate_to_dkk")) db.exec("ALTER TABLE bank_transactions ADD COLUMN fx_rate_to_dkk NUMERIC;");
  if (!hasColumn(db, "journal_entries", "currency")) db.exec("ALTER TABLE journal_entries ADD COLUMN currency TEXT NOT NULL DEFAULT 'DKK';");
  if (!hasColumn(db, "journal_entries", "amount_foreign")) db.exec("ALTER TABLE journal_entries ADD COLUMN amount_foreign NUMERIC;");
  if (!hasColumn(db, "journal_entries", "amount_dkk")) db.exec("ALTER TABLE journal_entries ADD COLUMN amount_dkk NUMERIC;");
  if (!hasColumn(db, "journal_entries", "fx_rate_to_dkk")) db.exec("ALTER TABLE journal_entries ADD COLUMN fx_rate_to_dkk NUMERIC;");
  if (!hasColumn(db, "invoice_payments", "journal_entry_id")) db.exec("ALTER TABLE invoice_payments ADD COLUMN journal_entry_id INTEGER;");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_payments_journal_entry ON invoice_payments(journal_entry_id) WHERE journal_entry_id IS NOT NULL;");
}

export function dbExists(path: string) {
  return existsSync(path);
}
