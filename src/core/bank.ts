import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { companyPaths } from "./paths";
import { insertAuditLog } from "./actor";
import { isValidIsoDate as looksLikeIsoDate } from "./dates";
import { retainUntilForDate } from "./retention";
import { compareDkk, multiplyDkk, roundDkk, roundRate6 } from "./money";

export type BankImportRow = {
  transactionDate: string;
  bookingDate?: string;
  text: string;
  amount: number;
  currency?: string;
  reference?: string;
  amountDkk?: number;
  fxRateToDkk?: number;
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
const FX_RULE_ID = "DK-BOOKKEEPING-FX-001";

function sha256Bytes(data: Uint8Array | string) {
  return createHash("sha256").update(data).digest("hex");
}


function normalizeAmount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? roundDkk(value) : NaN;
}

const HEADER_ALIASES: Record<string, string[]> = {
  transaction_date: ["transaction_date", "bogføringsdato", "bogforingsdato", "dato", "date"],
  booking_date: ["booking_date", "rentedato", "valørdato", "valordato", "posteringsdato"],
  text: ["text", "tekst", "description", "beskrivelse"],
  amount: ["amount", "beløb", "belob"],
  currency: ["currency", "valuta"],
  reference: ["reference", "ref", "bilagsnummer"],
  amount_dkk: ["amount_dkk", "beløb_dkk", "belob_dkk"],
  fx_rate_to_dkk: ["fx_rate_to_dkk", "kurs", "valutakurs"],
};

const REQUIRED_COLUMNS = ["transaction_date", "text", "amount"] as const;

type CsvParseResult = {
  rows: Record<string, string>[];
  errors: string[];
};

function normalizeHeader(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_");
}

function canonicalHeader(value: string) {
  const normalized = normalizeHeader(value);
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.map(normalizeHeader).includes(normalized)) return canonical;
  }
  return normalized;
}

function countDelimiterOutsideQuotes(line: string, delimiter: string) {
  let count = 0;
  let inQuotes = false;
  for (let idx = 0; idx < line.length; idx += 1) {
    const char = line[idx];
    if (char === '"') {
      if (inQuotes && line[idx + 1] === '"') idx += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && char === delimiter) {
      count += 1;
    }
  }
  return count;
}

function detectDelimiter(headerLine: string) {
  const candidates = [",", ";", "\t"];
  return candidates
    .map((delimiter) => ({ delimiter, count: countDelimiterOutsideQuotes(headerLine, delimiter) }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter ?? ",";
}

function parseCsvLine(line: string, delimiter: string) {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let idx = 0; idx < line.length; idx += 1) {
    const char = line[idx];
    if (char === '"') {
      if (inQuotes && line[idx + 1] === '"') {
        current += '"';
        idx += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && char === delimiter) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return { values, unterminatedQuote: inQuotes };
}

function parseCsv(content: string): CsvParseResult {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return { rows: [], errors: [] };

  const delimiter = detectDelimiter(lines[0]);
  const headerParsed = parseCsvLine(lines[0], delimiter);
  const header = headerParsed.values.map(canonicalHeader);
  const errors: string[] = [];
  if (headerParsed.unterminatedQuote) errors.push("CSV header has unterminated quoted field");
  for (const required of REQUIRED_COLUMNS) {
    if (!header.includes(required)) {
      errors.push(`CSV header missing required column: ${required} (accepted: ${HEADER_ALIASES[required].join(", ")})`);
    }
  }

  const rows: Record<string, string>[] = [];
  for (const [lineOffset, line] of lines.slice(1).entries()) {
    const lineNumber = lineOffset + 2;
    const parsed = parseCsvLine(line, delimiter);
    if (parsed.unterminatedQuote) errors.push(`CSV row ${lineNumber} has unterminated quoted field`);
    if (parsed.values.length !== header.length) {
      errors.push(`CSV row ${lineNumber} has ${parsed.values.length} fields, header has ${header.length}`);
      continue;
    }
    const row: Record<string, string> = {};
    header.forEach((key, idx) => row[key] = parsed.values[idx] ?? "");
    rows.push(row);
  }
  return { rows, errors };
}

// Strict numeric token: optional sign, digits, optional single dot + fraction.
// Rejects hex (0xff), scientific notation (1e3), Infinity, NaN, etc.
const STRICT_NUMERIC = /^[+-]?\d+(\.\d+)?$/;

function parseLocalizedNumber(value: string | undefined) {
  if (!value) return undefined;
  let trimmed = value.trim();
  if (!trimmed) return undefined;
  // Strip a trailing 3-letter ISO currency code that is whitespace-separated
  // from the number (e.g. "1234,56 DKK"). The whitespace requirement avoids
  // mangling garbage like "0xff" into a plausible amount.
  trimmed = trimmed.replace(/\s+[A-Za-z]{3}$/, "").trim();
  // Surrounding parentheses denote a negative amount in many bank exports.
  let sign = "";
  const paren = /^\((.*)\)$/.exec(trimmed);
  if (paren) {
    sign = "-";
    trimmed = paren[1].trim();
  }
  const compact = trimmed.replace(/\s/g, "");

  let normalized: string;
  if (compact.includes(",")) {
    // Comma present: comma is the decimal separator, dots are thousands.
    normalized = compact.replace(/\./g, "").replace(",", ".");
  } else if (/^[+-]?\d+(\.\d{3})+$/.test(compact)) {
    // Only digits and dots, every dot followed by exactly 3 digits and no
    // comma => Danish thousands grouping (e.g. "1.234" => 1234, "1.234.567").
    normalized = compact.replace(/\./g, "");
  } else {
    // Otherwise treat a single dot as a decimal point ("1234.56", "1234").
    normalized = compact;
  }

  normalized = sign + normalized;
  if (!STRICT_NUMERIC.test(normalized)) return NaN;
  return Number(normalized);
}

function normalizeDateText(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const match = /^(\d{2})[-/.](\d{2})[-/.](\d{4})$/.exec(trimmed);
  if (!match) return trimmed;
  const first = Number(match[1]);
  const second = Number(match[2]);
  // dd?dd?dddd is only unambiguously DD-MM-YYYY when one of the first two
  // components cannot be a month. If both are <= 12 the D/M order is a guess
  // (e.g. 05/04/2026), so refuse to reformat and let date validation reject it
  // rather than silently picking an interpretation.
  if (first <= 12 && second <= 12 && first !== second) return trimmed;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function normalizeAmountOrNull(value: unknown) {
  if (value === undefined || value === null) return null;
  const normalized = normalizeAmount(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function toRow(input: Record<string, string>): BankImportRow {
  return {
    transactionDate: normalizeDateText(input.transaction_date) ?? "",
    bookingDate: normalizeDateText(input.booking_date),
    text: input.text,
    amount: parseLocalizedNumber(input.amount) ?? NaN,
    currency: input.currency || "DKK",
    reference: input.reference || undefined,
    amountDkk: parseLocalizedNumber(input.amount_dkk),
    fxRateToDkk: parseLocalizedNumber(input.fx_rate_to_dkk),
  };
}

export function validateBankImportRows(rows: BankImportRow[]) {
  const errors: string[] = [];
  let needsFxRule = false;
  rows.forEach((row, idx) => {
    if (!looksLikeIsoDate(row.transactionDate)) errors.push(`rows[${idx}].transactionDate must be YYYY-MM-DD`);
    if (row.bookingDate && !looksLikeIsoDate(row.bookingDate)) errors.push(`rows[${idx}].bookingDate must be YYYY-MM-DD when present`);
    if (typeof row.text !== "string" || row.text.trim().length === 0) errors.push(`rows[${idx}].text is required`);
    if (!Number.isFinite(normalizeAmount(row.amount))) errors.push(`rows[${idx}].amount must be numeric`);

    const currency = (row.currency ?? "DKK").trim().toUpperCase();
    if (currency.length !== 3) errors.push(`rows[${idx}].currency must be a 3-letter ISO currency code`);
    if (currency !== "DKK") {
      needsFxRule = true;
      if (!Number.isFinite(normalizeAmount(row.amountDkk))) errors.push(`rows[${idx}].amountDkk is required for non-DKK rows`);
      if (!Number.isFinite(roundRate6(Number(row.fxRateToDkk))) || (row.fxRateToDkk ?? 0) <= 0) errors.push(`rows[${idx}].fxRateToDkk must be positive for non-DKK rows`);
      if (Number.isFinite(normalizeAmount(row.amountDkk)) && Number.isFinite(Number(row.fxRateToDkk))) {
        const expectedAmountDkk = multiplyDkk(row.amount ?? 0, row.fxRateToDkk ?? 0);
        if (compareDkk(normalizeAmount(row.amountDkk), expectedAmountDkk) !== 0) {
          errors.push(`rows[${idx}].amountDkk must equal amount * fxRateToDkk (${expectedAmountDkk})`);
        }
      }
    }
  });
  return { ok: errors.length === 0, appliedRules: needsFxRule ? [RULE_ID, FX_RULE_ID] : [RULE_ID], errors };
}

function transactionFingerprint(row: BankImportRow) {
  return sha256Bytes(JSON.stringify({
    transaction_date: row.transactionDate,
    booking_date: row.bookingDate ?? null,
    text: row.text.trim(),
    amount: normalizeAmount(row.amount),
    currency: row.currency ?? "DKK",
    reference: row.reference ?? null,
    amount_dkk: normalizeAmountOrNull(row.amountDkk),
    fx_rate_to_dkk: row.fxRateToDkk == null ? null : roundRate6(row.fxRateToDkk),
  }));
}

export function importBankCsv(db: Database, companyRoot: string, csvPath: string): BankImportResult {
  if (!existsSync(csvPath)) return { ok: false, errors: [`file does not exist: ${csvPath}`] };

  const fileBytes = readFileSync(csvPath);
  const sourceFileHash = sha256Bytes(fileBytes);
  const importBatchId = `BANK-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${sourceFileHash.slice(0, 8)}`;
  const parsedCsv = parseCsv(fileBytes.toString("utf8"));
  if (parsedCsv.errors.length > 0) return { ok: false, errors: parsedCsv.errors };
  const rows = parsedCsv.rows.map(toRow);
  const validation = validateBankImportRows(rows);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const p = companyPaths(companyRoot);
  mkdirSync(p.bankProcessed, { recursive: true });
  copyFileSync(csvPath, join(p.bankProcessed, `${importBatchId}-${basename(csvPath)}`));

  let imported = 0;
  let skippedDuplicates = 0;
  const insert = db.prepare(
    `INSERT INTO bank_transactions (
      transaction_date, booking_date, text, amount, currency, reference, amount_dkk, fx_rate_to_dkk, source_file_hash, import_batch_id, transaction_hash, status, retain_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?)`
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
        (row.currency ?? "DKK").trim().toUpperCase(),
        row.reference ?? null,
        normalizeAmountOrNull(row.amountDkk),
        row.fxRateToDkk == null ? null : roundRate6(row.fxRateToDkk),
        sourceFileHash,
        importBatchId,
        hash,
        retainUntilForDate(db, row.bookingDate ?? row.transactionDate),
      );
      imported += 1;
    }
    insertAuditLog(db, {
      eventType: "bank_import",
      entityType: "bank_transaction_batch",
      entityId: importBatchId,
      message: `Imported ${imported} bank transactions from ${basename(csvPath)}; skipped ${skippedDuplicates} duplicates`,
    });
  })();

  return { ok: true, importBatchId, imported, skippedDuplicates, sourceFileHash, errors: [] };
}
