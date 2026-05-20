import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { normalizeEanNumber } from "./ean";
import type { InvoicePayload } from "./invoice";
import { formatAmount } from "./money";

const RULE_ID = "DK-INVOICE-PUBLIC-EXPORT-001";

type ExportedInvoiceRow = {
  id: number;
  invoice_no: string | null;
  invoice_date: string | null;
  document_type: string;
  payload_json: string | null;
};

export type ExportPublicEInvoiceInput = {
  invoiceDocumentId: number;
  outPath?: string;
};

export type ExportPublicEInvoiceResult = {
  ok: boolean;
  invoiceNumber?: string;
  outPath?: string;
  sha256?: string;
  xml?: string;
  appliedRules: string[];
  errors: string[];
};

function escapeXml(value: string | number | null | undefined) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlTag(name: string, value: string | number | null | undefined, indent = "") {
  if (value === null || value === undefined || value === "") return "";
  return `${indent}<${name}>${escapeXml(value)}</${name}>`;
}

function buildPublicEInvoiceXml(invoiceNumber: string, payload: InvoicePayload) {
  const lines = payload.lines ?? [];
  const lineXml = lines
    .map((line, index) => [
      "      <Line>",
      xmlTag("LineNumber", index + 1, "        "),
      xmlTag("Description", line.description, "        "),
      xmlTag("Quantity", typeof line.quantity === "number" ? line.quantity : null, "        "),
      xmlTag("UnitPriceExVat", formatAmount(line.unitPriceExVat), "        "),
      xmlTag("LineTotalExVat", formatAmount(line.lineTotalExVat), "        "),
      "      </Line>",
    ].filter(Boolean).join("\n"))
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<PublicEInvoicePreview xmlns="urn:rentemester:dk:public-einvoice-preview:v1">',
    xmlTag("InvoiceNumber", invoiceNumber, "  "),
    xmlTag("IssueDate", payload.issueDate, "  "),
    xmlTag("DueDate", payload.dueDate, "  "),
    xmlTag("Currency", payload.currency ?? "DKK", "  "),
    xmlTag("Profile", "public-recipient-preview-only", "  "),
    xmlTag("Transport", "out_of_scope_peppol_access_point_required", "  "),
    "  <Seller>",
    xmlTag("Name", payload.seller?.name, "    "),
    xmlTag("Address", payload.seller?.address, "    "),
    xmlTag("VatOrCvr", payload.seller?.vatOrCvr, "    "),
    "  </Seller>",
    "  <Buyer>",
    xmlTag("Name", payload.buyer?.name, "    "),
    xmlTag("Address", payload.buyer?.address, "    "),
    xmlTag("VatOrCvr", payload.buyer?.vatOrCvr, "    "),
    xmlTag("EanNumber", payload.buyer?.eanNumber, "    "),
    "  </Buyer>",
    "  <Delivery>",
    xmlTag("DeliveryDate", payload.deliveryDate, "    "),
    xmlTag("DeliveryPeriodStart", payload.deliveryPeriodStart, "    "),
    xmlTag("DeliveryPeriodEnd", payload.deliveryPeriodEnd, "    "),
    "  </Delivery>",
    "  <Totals>",
    xmlTag("NetAmount", formatAmount(payload.totals?.netAmount), "    "),
    xmlTag("VatRate", typeof payload.totals?.vatRate === "number" ? payload.totals.vatRate : null, "    "),
    xmlTag("VatAmount", formatAmount(payload.totals?.vatAmount), "    "),
    xmlTag("GrossAmount", formatAmount(payload.totals?.grossAmount), "    "),
    "  </Totals>",
    "  <Lines>",
    lineXml,
    "  </Lines>",
    "</PublicEInvoicePreview>",
    "",
  ].filter((line) => line !== "").join("\n");
}

export function exportPublicEInvoicePreview(
  db: Database,
  input: ExportPublicEInvoiceInput,
): ExportPublicEInvoiceResult {
  const row = db.query(
    `SELECT id, invoice_no, invoice_date, document_type, payload_json
     FROM documents
     WHERE id = ? LIMIT 1`,
  ).get(input.invoiceDocumentId) as ExportedInvoiceRow | null;

  if (!row) {
    return { ok: false, appliedRules: [RULE_ID], errors: [`invoice ${input.invoiceDocumentId} was not found`] };
  }
  if (row.document_type !== "issued_invoice") {
    return { ok: false, appliedRules: [RULE_ID], errors: [`document ${input.invoiceDocumentId} is not an issued invoice`] };
  }
  if (!row.payload_json) {
    return { ok: false, appliedRules: [RULE_ID], errors: [`invoice ${row.invoice_no ?? input.invoiceDocumentId} is missing payload_json`] };
  }

  const payload = JSON.parse(row.payload_json) as InvoicePayload & { invoiceNumber?: string };
  const invoiceNumber = payload.invoiceNumber ?? row.invoice_no ?? String(input.invoiceDocumentId);
  const eanNumber = normalizeEanNumber(payload.buyer?.eanNumber);

  if (payload.buyer?.publicRecipient !== true && !eanNumber) {
    return {
      ok: false,
      appliedRules: [RULE_ID],
      errors: [`invoice ${invoiceNumber} is not marked as a public-recipient e-invoice`],
    };
  }
  if (!eanNumber) {
    return {
      ok: false,
      appliedRules: [RULE_ID],
      errors: [`invoice ${invoiceNumber} is missing buyer.eanNumber as 13 digits`],
    };
  }

  const normalizedPayload: InvoicePayload = {
    ...payload,
    buyer: {
      ...payload.buyer,
      eanNumber,
      publicRecipient: true,
    },
  };

  const xml = buildPublicEInvoiceXml(invoiceNumber, normalizedPayload);
  const sha256 = createHash("sha256").update(xml).digest("hex");
  if (input.outPath) writeFileSync(input.outPath, xml);

  return {
    ok: true,
    invoiceNumber,
    outPath: input.outPath,
    sha256,
    xml,
    appliedRules: [RULE_ID],
    errors: [],
  };
}
