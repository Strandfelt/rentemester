import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { companyPaths } from "./paths";
import { validateInvoice, type InvoicePayload } from "./invoice";
import { promoteTempFile, removeIfExists, writeTempFileFor } from "./atomic-file";
import { insertAuditLog } from "./actor";
import { companySequenceScope, fiscalYearLabelFromDate, reserveSequenceValue, nextSequenceValue } from "./sequences";
import { retainUntilForDate } from "./retention";
import { requireCachedViesValidation } from "./vies";
import { buildIssuedInvoicePdf } from "./invoice-pdf";

export type IssueInvoiceResult = {
  ok: boolean;
  documentId?: number;
  invoiceNumber?: string;
  storedPath?: string;
  sha256?: string;
  pdfDocumentId?: number;
  pdfStoredPath?: string;
  pdfSha256?: string;
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

// Manual invoice numbers must be <scope>-<digits>: the scope is everything
// before the final hyphen, the suffix is one or more decimal digits. The
// numeric value of the suffix is what is reserved against the sequence — the
// invoice-number string itself is always stored verbatim (no re-padding).
const MANUAL_INVOICE_NUMBER_RE = /^(.+)-([0-9]+)$/;

function validateManualInvoiceNumberScope(db: Database, issueDate: string, invoiceNumber: string) {
  const { scope } = invoiceSequenceState(db, issueDate);
  const match = MANUAL_INVOICE_NUMBER_RE.exec(invoiceNumber);
  if (!match) {
    return `manual invoiceNumber ${invoiceNumber} must be of the form <scope>-<number>`;
  }
  if (match[1] !== scope) {
    return `manual invoiceNumber ${invoiceNumber} does not match current fiscal scope ${scope}`;
  }
  return null;
}

function reserveManualInvoiceNumber(db: Database, issueDate: string, invoiceNumber: string) {
  const { scope, currentFloor, sequenceScope } = invoiceSequenceState(db, issueDate);
  const match = MANUAL_INVOICE_NUMBER_RE.exec(invoiceNumber);
  if (!match || match[1] !== scope) {
    return { ok: false as const, error: `manual invoiceNumber ${invoiceNumber} must be of the form <scope>-<number>` };
  }
  const requestedValue = Number(match[2]);
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

  let viesValidation: ReturnType<typeof requireCachedViesValidation>["validation"] | undefined;
  if (payload.vatTreatment === "foreign_reverse_charge") {
    const viesCheck = requireCachedViesValidation(db, payload.buyer?.vatOrCvr, "buyer.vatOrCvr");
    if (!viesCheck.ok) return { ok: false, appliedRules: [...new Set([...appliedRules, ...viesCheck.appliedRules])], errors: viesCheck.errors };
    viesValidation = viesCheck.validation;
  }

  const explicitInvoiceNumber = payload.invoiceNumber?.trim();
  if (explicitInvoiceNumber) {
    const scopeError = validateManualInvoiceNumberScope(db, payload.issueDate!, explicitInvoiceNumber);
    if (scopeError) return { ok: false, appliedRules, errors: [scopeError] };
  }
  const paths = companyPaths(companyRoot);
  mkdirSync(paths.invoicesIssued, { recursive: true });

  let tempPath: string | undefined;
  let storedPath: string | undefined;
  let pdfTempPath: string | undefined;
  let pdfStoredPath: string | undefined;

  try {
    const result = db.transaction(() => {
      let invoiceNumber = explicitInvoiceNumber;
      if (invoiceNumber) {
        const reserved = reserveManualInvoiceNumber(db, payload.issueDate!, invoiceNumber);
        if (!reserved.ok) return { ok: false as const, error: reserved.error };
      } else {
        invoiceNumber = nextIssuedInvoiceNumber(db, payload.issueDate!);
      }

      const issuedAt = new Date().toISOString();
      const issuedPayload = {
        ...payload,
        invoiceNumber,
        issuedAt,
        status: "issued",
        ...(viesValidation ? { viesValidation } : {}),
      };
      const serialized = JSON.stringify(issuedPayload, null, 2);
      const hash = sha256(serialized);
      const pdfBytes = buildIssuedInvoicePdf(issuedPayload);
      const pdfHash = createHash("sha256").update(pdfBytes).digest("hex");
      storedPath = join(paths.invoicesIssued, `${invoiceNumber}.json`);
      pdfStoredPath = join(paths.invoicesIssued, `${invoiceNumber}.pdf`);
      tempPath = writeTempFileFor(storedPath, serialized);
      pdfTempPath = writeTempFileFor(pdfStoredPath, pdfBytes);

      const grossAmount = payload.totals?.grossAmount ?? null;
      const vatAmount = payload.totals?.vatAmount ?? null;
      const inserted = db.query(
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

      const pdfInserted = db.query(
      `INSERT INTO documents (
        document_no, source, original_filename, stored_path, mime_type, sha256_hash,
        supplier_name, invoice_no, invoice_date, amount_inc_vat, currency, status,
        document_type, sender_name, sender_address, sender_vat_cvr,
        recipient_name, recipient_address, recipient_vat_cvr, vat_amount, payload_json, retain_until
      ) VALUES (?, 'rentemester', ?, ?, 'application/pdf', ?, ?, ?, ?, ?, ?, 'issued', 'issued_invoice_pdf', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id`
    ).get(
      `${invoiceNumber}-pdf`,
      `${invoiceNumber}.pdf`,
      pdfStoredPath,
      pdfHash,
      payload.seller?.name ?? null,
      invoiceNumber,
      payload.issueDate ?? null,
      grossAmount,
      payload.currency ?? 'DKK',
      payload.seller?.name ?? null,
      payload.seller?.address ?? null,
      payload.seller?.vatOrCvr ?? null,
      payload.buyer?.name ?? null,
      payload.buyer?.address ?? null,
      payload.buyer?.vatOrCvr ?? null,
      vatAmount,
      serialized,
      retainUntilForDate(db, payload.issueDate),
    ) as { id: number };

      insertAuditLog(db, {
        eventType: "invoice_issue",
        entityType: "document",
        entityId: inserted.id,
        message: `Issued invoice ${invoiceNumber}`,
      });
      insertAuditLog(db, {
        eventType: "invoice_render_pdf",
        entityType: "document",
        entityId: pdfInserted.id,
        message: `Rendered invoice PDF ${invoiceNumber}`,
      });

      return { ok: true as const, documentId: inserted.id, invoiceNumber, sha256: hash, pdfDocumentId: pdfInserted.id, pdfSha256: pdfHash };
    }, { immediate: true })();

    if (!result.ok) return { ok: false, appliedRules, errors: [result.error] };
    promoteTempFile(tempPath!, storedPath!);
    promoteTempFile(pdfTempPath!, pdfStoredPath!);
    return {
      ok: true,
      documentId: result.documentId,
      invoiceNumber: result.invoiceNumber,
      storedPath,
      sha256: result.sha256,
      pdfDocumentId: result.pdfDocumentId,
      pdfStoredPath,
      pdfSha256: result.pdfSha256,
      appliedRules,
      errors: [],
    };
  } catch (error) {
    if (tempPath) removeIfExists(tempPath);
    if (pdfTempPath) removeIfExists(pdfTempPath);
    throw error;
  }
}
