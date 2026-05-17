import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { companyPaths } from "./paths";
import { validateInvoice, type InvoicePayload } from "./invoice";
import { promoteTempFile, removeIfExists, writeTempFileFor } from "./atomic-file";
import { insertAuditLog } from "./actor";
import { companySequenceScope, fiscalYearLabelFromDate, nextSequenceValue, reserveSequenceValue } from "./sequences";
import { retainUntilForDate } from "./retention";

export type IssueInvoiceResult = {
  ok: boolean;
  documentId?: number;
  invoiceNumber?: string;
  storedPath?: string;
  sha256?: string;
  appliedRules: string[];
  errors: string[];
};

const RULE_ID = "DK-INVOICE-ISSUE-001";
const LOCK_RULE_ID = "DK-INVOICE-LOCK-001";

function deliveryDescription(payload: InvoicePayload) {
  if (payload.deliveryDate) return `Delivery date ${payload.deliveryDate}`;
  if (payload.deliveryPeriodStart && payload.deliveryPeriodEnd) {
    return `Delivery period ${payload.deliveryPeriodStart}..${payload.deliveryPeriodEnd}`;
  }
  return payload.lines?.map((l) => l.description).filter(Boolean).join('; ') ?? null;
}

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function canonicalInvoiceNumber(scope: string, value: number) {
  return `${scope}-${String(value).padStart(5, "0")}`;
}

function invoiceSequenceState(db: Database, issueDate: string) {
  const scope = fiscalYearLabelFromDate(db, issueDate);
  const row = db.query(`SELECT COALESCE(MAX(CAST(substr(invoice_no, -5) AS INTEGER)), 0) AS n FROM documents WHERE document_type = 'issued_invoice' AND invoice_no GLOB ?`).get(`${scope}-[0-9][0-9][0-9][0-9][0-9]`) as { n: number };
  return { scope, currentFloor: Number(row.n ?? 0), sequenceScope: companySequenceScope(db, scope) };
}

function reserveManualInvoiceNumber(db: Database, issueDate: string, invoiceNumber: string) {
  const { scope, currentFloor, sequenceScope } = invoiceSequenceState(db, issueDate);
  const match = new RegExp(`^${scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-([0-9]{5})$`).exec(invoiceNumber);
  if (!match) return { ok: true as const, invoiceNumber };
  const requestedValue = Number(match[1]);
  const reserved = reserveSequenceValue(db, "issued_invoice", sequenceScope, requestedValue, currentFloor);
  if (!reserved.ok) {
    return {
      ok: false as const,
      error: `manual invoiceNumber ${invoiceNumber} exceeds næste fortløbende nummer ${canonicalInvoiceNumber(scope, reserved.expectedValue)}`,
    };
  }
  return { ok: true as const, invoiceNumber };
}

function nextIssuedInvoiceNumber(db: Database, issueDate: string) {
  const { scope, currentFloor, sequenceScope } = invoiceSequenceState(db, issueDate);
  const nextValue = nextSequenceValue(db, "issued_invoice", sequenceScope, currentFloor);
  return canonicalInvoiceNumber(scope, nextValue);
}

export function issueInvoice(db: Database, companyRoot: string, payload: InvoicePayload): IssueInvoiceResult {
  const validation = validateInvoice(payload);
  const appliedRules = [...new Set([...(validation.appliedRules ?? []), RULE_ID, LOCK_RULE_ID])];
  if (!validation.ok) return { ok: false, appliedRules, errors: validation.errors };

  const explicitInvoiceNumber = payload.invoiceNumber?.trim();
  if (explicitInvoiceNumber) {
    const reserved = reserveManualInvoiceNumber(db, payload.issueDate!, explicitInvoiceNumber);
    if (!reserved.ok) return { ok: false, appliedRules, errors: [reserved.error] };
  }
  const invoiceNumber = explicitInvoiceNumber || nextIssuedInvoiceNumber(db, payload.issueDate!);
  const paths = companyPaths(companyRoot);
  mkdirSync(paths.invoicesIssued, { recursive: true });

  const issuedAt = new Date().toISOString();
  const issuedPayload = {
    ...payload,
    invoiceNumber,
    issuedAt,
    status: "issued",
  };
  const serialized = JSON.stringify(issuedPayload, null, 2);
  const hash = sha256(serialized);
  const storedPath = join(paths.invoicesIssued, `${invoiceNumber}.json`);
  const tempPath = writeTempFileFor(storedPath, serialized);

  try {
    const grossAmount = payload.totals?.grossAmount ?? null;
    const vatAmount = payload.totals?.vatAmount ?? null;
    const result = db.query(
    `INSERT INTO documents (
      document_no, source, original_filename, stored_path, mime_type, sha256_hash,
      supplier_name, invoice_no, invoice_date, amount_inc_vat, currency, status,
      document_type, delivery_description, sender_name, sender_address, sender_vat_cvr,
      recipient_name, recipient_address, recipient_vat_cvr, vat_amount, payment_details, exemption_code, payload_json, retain_until
    ) VALUES (?, 'rentemester', ?, ?, 'application/json', ?, ?, ?, ?, ?, ?, 'issued', 'issued_invoice', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    RETURNING id`
  ).get(
    invoiceNumber,
    `${invoiceNumber}.json`,
    storedPath,
    hash,
    payload.seller?.name ?? null,
    invoiceNumber,
    payload.issueDate ?? null,
    grossAmount,
    payload.currency ?? 'DKK',
    deliveryDescription(payload),
    payload.seller?.name ?? null,
    payload.seller?.address ?? null,
    payload.seller?.vatOrCvr ?? null,
    payload.buyer?.name ?? null,
    payload.buyer?.address ?? null,
    payload.buyer?.vatOrCvr ?? null,
    vatAmount,
    payload.reverseChargeBasis ?? null,
    serialized,
    retainUntilForDate(db, payload.issueDate),
  ) as { id: number };

    insertAuditLog(db, {
      eventType: "invoice_issue",
      entityType: "document",
      entityId: result.id,
      message: `Issued invoice ${invoiceNumber}`,
    });

    promoteTempFile(tempPath, storedPath);
    return { ok: true, documentId: result.id, invoiceNumber, storedPath, sha256: hash, appliedRules, errors: [] };
  } catch (error) {
    removeIfExists(tempPath);
    throw error;
  }
}
