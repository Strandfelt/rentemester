import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { companyPaths } from "./paths";

export type BankImportRow = {
  transactionDate: string;
  bookingDate?: string;
  text: string;
  amount: number;
  currency?: string;
  reference?: string;
};

export type BankImportResult = {
  ok: boolean;
  importBatchId?: string;
  imported?: number;
  skippedDuplicates?: number;
  sourceFileHash?: string;
  errors: string[];
};

const RULE_ID = "DK-BOOKKEEPING-BANK-IMPORT-001";

function sha256Bytes(data: Uint8Array | string) {
  return createHash("sha256").update(data).digest("hex");
}

function looksLikeIsoDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function normalizeAmount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(2)) : NaN;
}

function parseCsv(content: string) {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((s) => s.trim());
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    const values = line.split(",").map((s) => s.trim());
    const row: Record<string, string> = {};
    header.forEach((key, idx) => row[key] = values[idx] ?? "");
    rows.push(row);
  }
  return rows;
}

function toRow(input: Record<string, string>): BankImportRow {
  return {
    transactionDate: input.transaction_date,
    bookingDate: input.booking_date || undefined,
    text: input.text,
    amount: Number(input.amount),
    currency: input.currency || "DKK",
    reference: input.reference || undefined,
  };
}

export function validateBankImportRows(rows: BankImportRow[]) {
  const errors: string[] = [];
  rows.forEach((row, idx) => {
    if (!looksLikeIsoDate(row.transactionDate)) errors.push(`rows[${idx}].transactionDate must be YYYY-MM-DD`);
    if (row.bookingDate && !looksLikeIsoDate(row.bookingDate)) errors.push(`rows[${idx}].bookingDate must be YYYY-MM-DD when present`);
    if (typeof row.text !== "string" || row.text.trim().length === 0) errors.push(`rows[${idx}].text is required`);
    if (!Number.isFinite(normalizeAmount(row.amount))) errors.push(`rows[${idx}].amount must be numeric`);
    if ((row.currency ?? "DKK") !== "DKK") errors.push(`rows[${idx}].currency must be DKK in the current deterministic importer`);
  });
  return { ok: errors.length === 0, appliedRules: [RULE_ID], errors };
}

function transactionFingerprint(row: BankImportRow) {
  return sha256Bytes(JSON.stringify({
    transaction_date: row.transactionDate,
    booking_date: row.bookingDate ?? null,
    text: row.text.trim(),
    amount: normalizeAmount(row.amount),
    currency: row.currency ?? "DKK",
    reference: row.reference ?? null,
  }));
}

export function importBankCsv(db: Database, companyRoot: string, csvPath: string): BankImportResult {
  if (!existsSync(csvPath)) return { ok: false, errors: [`file does not exist: ${csvPath}`] };

  const fileBytes = readFileSync(csvPath);
  const sourceFileHash = sha256Bytes(fileBytes);
  const importBatchId = `BANK-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${sourceFileHash.slice(0, 8)}`;
  const rows = parseCsv(fileBytes.toString("utf8")).map(toRow);
  const validation = validateBankImportRows(rows);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const p = companyPaths(companyRoot);
  mkdirSync(p.bankProcessed, { recursive: true });
  copyFileSync(csvPath, join(p.bankProcessed, `${importBatchId}-${basename(csvPath)}`));

  let imported = 0;
  let skippedDuplicates = 0;
  const insert = db.prepare(
    `INSERT INTO bank_transactions (
      transaction_date, booking_date, text, amount, currency, reference, source_file_hash, import_batch_id, transaction_hash, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported')`
  );

  db.transaction(() => {
    for (const row of rows) {
      const hash = transactionFingerprint(row);
      const existing = db.query("SELECT id FROM bank_transactions WHERE transaction_hash = ?").get(hash) as { id: number } | null;
      if (existing) {
        skippedDuplicates += 1;
        continue;
      }
      insert.run(
        row.transactionDate,
        row.bookingDate ?? null,
        row.text.trim(),
        normalizeAmount(row.amount),
        row.currency ?? "DKK",
        row.reference ?? null,
        sourceFileHash,
        importBatchId,
        hash,
      );
      imported += 1;
    }
    db.run(
      "INSERT INTO audit_log (event_type, entity_type, entity_id, message) VALUES ('bank_import', 'bank_transaction_batch', ?, ?)",
      importBatchId,
      `Imported ${imported} bank transactions from ${basename(csvPath)}; skipped ${skippedDuplicates} duplicates`
    );
  })();

  return { ok: true, importBatchId, imported, skippedDuplicates, sourceFileHash, errors: [] };
}
