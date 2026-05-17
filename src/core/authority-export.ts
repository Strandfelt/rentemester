import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Database } from "bun:sqlite";
import { companyPaths } from "./paths";

const RULE_ID = "DK-BOOKKEEPING-AUTHORITY-EXPORT-001";
const FOUR_WEEKS_MS = 28 * 24 * 60 * 60 * 1000;

export type ExportAuthorityPackageInput = {
  periodStart: string;
  periodEnd: string;
  outputDir: string;
  requestedAt?: string;
  requester?: string;
};

export type ExportAuthorityPackageResult = {
  ok: boolean;
  exportDir?: string;
  manifestPath?: string;
  periodStart?: string;
  periodEnd?: string;
  generatedAt?: string;
  deadlineAt?: string | null;
  journalEntryCount?: number;
  bankTransactionCount?: number;
  documentCount?: number;
  appliedRules: string[];
  errors: string[];
};

type JournalLineRecord = {
  accountNo: string;
  accountName: string;
  debitAmount: number;
  creditAmount: number;
  vatCode: string | null;
  text: string | null;
};

type JournalEntryRecord = {
  id: number;
  entryNo: string;
  transactionDate: string;
  registrationDatetime: string;
  text: string;
  documentId: number | null;
  sourceBankTransactionId: number | null;
  currency: string;
  amountForeign: number | null;
  amountDkk: number | null;
  fxRateToDkk: number | null;
  status: string;
  reversalOfEntryId: number | null;
  createdBy: string;
  createdByProgram: string;
  lines: JournalLineRecord[];
};

type DocumentRecord = {
  id: number;
  documentNo: string | null;
  documentType: string;
  invoiceNo: string | null;
  invoiceDate: string | null;
  originalFilename: string | null;
  storedPath: string | null;
  mimeType: string | null;
  source: string;
  amountIncVat: number | null;
  vatAmount: number | null;
  status: string;
};

type BankTransactionRecord = {
  id: number;
  transactionDate: string;
  bookingDate: string | null;
  text: string;
  amount: number;
  currency: string;
  amountDkk: number | null;
  fxRateToDkk: number | null;
  reference: string | null;
  importBatchId: string | null;
  status: string;
};

function looksLikeIsoDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function resolveIsoDateTime(value?: string) {
  const iso = value ?? new Date().toISOString();
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function packageName(periodStart: string, periodEnd: string, generatedAt: string) {
  return `authority-export-${periodStart}_${periodEnd}_${generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

function jsonWrite(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function uniqueDocumentIds(values: Array<number | null | undefined>) {
  return [...new Set(values.filter((value): value is number => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
}

function exportFileName(document: DocumentRecord) {
  const base = document.documentNo ?? `document-${document.id}`;
  const original = document.originalFilename ?? basename(document.storedPath ?? `document-${document.id}`);
  return `${base}-${original}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

function fetchJournalEntries(db: Database, periodStart: string, periodEnd: string): JournalEntryRecord[] {
  const entries = db.query(
    `SELECT id, entry_no, transaction_date, registration_datetime, text, document_id, source_bank_transaction_id,
            currency, amount_foreign, amount_dkk, fx_rate_to_dkk,
            status, reversal_of_entry_id, created_by, created_by_program
     FROM journal_entries
     WHERE transaction_date BETWEEN ? AND ?
     ORDER BY transaction_date ASC, id ASC`
  ).all(periodStart, periodEnd) as any[];

  const linesStmt = db.query(
    `SELECT a.account_no, a.name AS account_name, jl.debit_amount, jl.credit_amount, jl.vat_code, jl.text
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id
     WHERE jl.journal_entry_id = ?
     ORDER BY jl.id ASC`
  );

  return entries.map((entry) => ({
    id: entry.id,
    entryNo: entry.entry_no,
    transactionDate: entry.transaction_date,
    registrationDatetime: entry.registration_datetime,
    text: entry.text,
    documentId: entry.document_id ?? null,
    sourceBankTransactionId: entry.source_bank_transaction_id ?? null,
    currency: entry.currency,
    amountForeign: entry.amount_foreign == null ? null : Number(entry.amount_foreign),
    amountDkk: entry.amount_dkk == null ? null : Number(entry.amount_dkk),
    fxRateToDkk: entry.fx_rate_to_dkk == null ? null : Number(entry.fx_rate_to_dkk),
    status: entry.status,
    reversalOfEntryId: entry.reversal_of_entry_id ?? null,
    createdBy: entry.created_by,
    createdByProgram: entry.created_by_program,
    lines: (linesStmt.all(entry.id) as any[]).map((line) => ({
      accountNo: line.account_no,
      accountName: line.account_name,
      debitAmount: Number(line.debit_amount),
      creditAmount: Number(line.credit_amount),
      vatCode: line.vat_code ?? null,
      text: line.text ?? null,
    })),
  }));
}

function fetchDocuments(db: Database, journalEntries: JournalEntryRecord[], periodStart: string, periodEnd: string): DocumentRecord[] {
  const linkedIds = uniqueDocumentIds(journalEntries.map((entry) => entry.documentId));
  const linkedDocuments = linkedIds.length === 0 ? [] : db.query(
    `SELECT id, document_no, document_type, invoice_no, invoice_date, original_filename, stored_path, mime_type, source,
            amount_inc_vat, vat_amount, status
     FROM documents WHERE id IN (${linkedIds.map(() => "?").join(",")})`
  ).all(...linkedIds) as any[];

  const issuedInPeriod = db.query(
    `SELECT id, document_no, document_type, invoice_no, invoice_date, original_filename, stored_path, mime_type, source,
            amount_inc_vat, vat_amount, status
     FROM documents
     WHERE invoice_date BETWEEN ? AND ?
     ORDER BY id ASC`
  ).all(periodStart, periodEnd) as any[];

  const dedup = new Map<number, DocumentRecord>();
  for (const row of [...linkedDocuments, ...issuedInPeriod]) {
    dedup.set(row.id, {
      id: row.id,
      documentNo: row.document_no ?? null,
      documentType: row.document_type,
      invoiceNo: row.invoice_no ?? null,
      invoiceDate: row.invoice_date ?? null,
      originalFilename: row.original_filename ?? null,
      storedPath: row.stored_path ?? null,
      mimeType: row.mime_type ?? null,
      source: row.source,
      amountIncVat: row.amount_inc_vat == null ? null : Number(row.amount_inc_vat),
      vatAmount: row.vat_amount == null ? null : Number(row.vat_amount),
      status: row.status,
    });
  }
  return [...dedup.values()].sort((a, b) => a.id - b.id);
}

function fetchBankTransactions(db: Database, journalEntries: JournalEntryRecord[], periodStart: string, periodEnd: string): BankTransactionRecord[] {
  const linkedIds = uniqueDocumentIds(journalEntries.map((entry) => entry.sourceBankTransactionId));
  const linked = linkedIds.length === 0 ? [] : db.query(
    `SELECT id, transaction_date, booking_date, text, amount, currency, amount_dkk, fx_rate_to_dkk, reference, import_batch_id, status
     FROM bank_transactions WHERE id IN (${linkedIds.map(() => "?").join(",")})`
  ).all(...linkedIds) as any[];
  const inPeriod = db.query(
    `SELECT id, transaction_date, booking_date, text, amount, currency, amount_dkk, fx_rate_to_dkk, reference, import_batch_id, status
     FROM bank_transactions
     WHERE COALESCE(booking_date, transaction_date) BETWEEN ? AND ?
     ORDER BY COALESCE(booking_date, transaction_date) ASC, id ASC`
  ).all(periodStart, periodEnd) as any[];

  const dedup = new Map<number, BankTransactionRecord>();
  for (const row of [...linked, ...inPeriod]) {
    dedup.set(row.id, {
      id: row.id,
      transactionDate: row.transaction_date,
      bookingDate: row.booking_date ?? null,
      text: row.text,
      amount: Number(row.amount),
      currency: row.currency,
      amountDkk: row.amount_dkk == null ? null : Number(row.amount_dkk),
      fxRateToDkk: row.fx_rate_to_dkk == null ? null : Number(row.fx_rate_to_dkk),
      reference: row.reference ?? null,
      importBatchId: row.import_batch_id ?? null,
      status: row.status,
    });
  }
  return [...dedup.values()].sort((a, b) => a.id - b.id);
}

export function exportAuthorityPackage(db: Database, companyRoot: string, input: ExportAuthorityPackageInput): ExportAuthorityPackageResult {
  const errors: string[] = [];
  if (!looksLikeIsoDate(input.periodStart)) errors.push("periodStart must be YYYY-MM-DD");
  if (!looksLikeIsoDate(input.periodEnd)) errors.push("periodEnd must be YYYY-MM-DD");
  if (typeof input.outputDir !== "string" || input.outputDir.trim().length === 0) errors.push("outputDir is required");
  if (errors.length === 0 && input.periodStart > input.periodEnd) errors.push("periodStart cannot be after periodEnd");
  const requestedAt = resolveIsoDateTime(input.requestedAt);
  if (input.requestedAt && !requestedAt) errors.push("requestedAt must be a valid ISO-8601 datetime when provided");
  if (errors.length > 0) return { ok: false, appliedRules: [RULE_ID], errors };

  const generatedAt = new Date().toISOString();
  const deadlineAt = requestedAt ? new Date(new Date(requestedAt).getTime() + FOUR_WEEKS_MS).toISOString() : null;
  const exportDir = join(input.outputDir, packageName(input.periodStart, input.periodEnd, requestedAt ?? generatedAt));
  const machineReadableDir = join(exportDir, "machine-readable");
  const documentsDir = join(exportDir, "documents-readable");
  mkdirSync(machineReadableDir, { recursive: true });
  mkdirSync(documentsDir, { recursive: true });

  const journalEntries = fetchJournalEntries(db, input.periodStart, input.periodEnd);
  const documents = fetchDocuments(db, journalEntries, input.periodStart, input.periodEnd);
  const bankTransactions = fetchBankTransactions(db, journalEntries, input.periodStart, input.periodEnd);

  jsonWrite(join(machineReadableDir, "journal-entries.json"), journalEntries);
  jsonWrite(join(machineReadableDir, "documents.json"), documents.map((document) => ({
    ...document,
    exportedReadablePath: document.storedPath ? join("documents-readable", exportFileName(document)) : null,
  })));
  jsonWrite(join(machineReadableDir, "bank-transactions.json"), bankTransactions);

  const copiedDocuments: Array<{ documentId: number; sourcePath: string; exportedPath: string }> = [];
  for (const document of documents) {
    if (!document.storedPath || !existsSync(document.storedPath)) continue;
    const target = join(documentsDir, exportFileName(document));
    copyFileSync(document.storedPath, target);
    copiedDocuments.push({ documentId: document.id, sourcePath: document.storedPath, exportedPath: target });
  }

  const manifest = {
    packageType: "authority_export",
    generatedAt,
    requestedAt: requestedAt ?? null,
    deadlineAt,
    requester: input.requester ?? null,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    companyRoot,
    appliedRules: [RULE_ID],
    machineReadableFormat: "json",
    files: {
      journalEntries: join(machineReadableDir, "journal-entries.json"),
      documents: join(machineReadableDir, "documents.json"),
      bankTransactions: join(machineReadableDir, "bank-transactions.json"),
      readableDocumentsDir: documentsDir,
    },
    counts: {
      journalEntries: journalEntries.length,
      bankTransactions: bankTransactions.length,
      documents: documents.length,
      copiedReadableDocuments: copiedDocuments.length,
    },
    copiedDocuments,
  };
  const manifestPath = join(exportDir, "manifest.json");
  jsonWrite(manifestPath, manifest);

  db.run(
    "INSERT INTO audit_log (event_type, entity_type, entity_id, message) VALUES ('authority_export', 'company', '1', ?)",
    `Exported bookkeeping package for ${input.periodStart}..${input.periodEnd} to ${exportDir}`,
  );

  return {
    ok: true,
    exportDir,
    manifestPath,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    generatedAt,
    deadlineAt,
    journalEntryCount: journalEntries.length,
    bankTransactionCount: bankTransactions.length,
    documentCount: documents.length,
    appliedRules: [RULE_ID],
    errors: [],
  };
}
