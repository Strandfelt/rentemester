import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { insertAuditLog } from "./actor";
import { normalizeEanNumber } from "./ean";
import type { InvoicePayload } from "./invoice";
import { formatAmount } from "./money";

const RULE_ID = "DK-INVOICE-PUBLIC-EXPORT-001";
const OIOUBL_RULE_ID = "DK-INVOICE-PUBLIC-OIOUBL-001";
const OIOUBL_UBL_VERSION = "2.1";
const OIOUBL_CUSTOMIZATION_ID = "urn:fdc:oioubl.dk:trns:billing:invoice:3.0";
const OIOUBL_PROFILE_ID = "urn:fdc:oioubl.dk:bis:billing_with_response:3";

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

function xmlTagWithAttrs(
  name: string,
  attrs: Record<string, string | number | null | undefined>,
  value: string | number | null | undefined,
  indent = "",
) {
  if (value === null || value === undefined || value === "") return "";
  const renderedAttrs = Object.entries(attrs)
    .filter(([, attrValue]) => attrValue !== null && attrValue !== undefined && attrValue !== "")
    .map(([key, attrValue]) => ` ${key}="${escapeXml(attrValue)}"`)
    .join("");
  return `${indent}<${name}${renderedAttrs}>${escapeXml(value)}</${name}>`;
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function formatVatPercent(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Number.isInteger(value) ? String(value) : String(value <= 1 ? value * 100 : value);
}

function buildAddressXml(tagName: string, address: string | null | undefined, indent = "") {
  if (!hasText(address)) return "";
  return [
    `${indent}<${tagName}>`,
    `${indent}  <cac:AddressLine>`,
    xmlTag("cbc:Line", address.trim(), `${indent}    `),
    `${indent}  </cac:AddressLine>`,
    `${indent}</${tagName}>`,
  ].join("\n");
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

function validateOioUblPayload(invoiceNumber: string, payload: InvoicePayload, eanNumber: string | null) {
  const errors: string[] = [];
  if (!hasText(payload.issueDate)) errors.push(`invoice ${invoiceNumber} is missing issueDate required for OIOUBL handoff`);
  if (!hasText(payload.dueDate)) errors.push(`invoice ${invoiceNumber} is missing dueDate required for OIOUBL handoff`);
  if (!hasText(payload.seller?.name)) errors.push(`invoice ${invoiceNumber} is missing seller.name required for OIOUBL handoff`);
  if (!hasText(payload.seller?.address)) errors.push(`invoice ${invoiceNumber} is missing seller.address required for OIOUBL handoff`);
  if (!hasText(payload.seller?.vatOrCvr)) errors.push(`invoice ${invoiceNumber} is missing seller.vatOrCvr required for OIOUBL handoff`);
  if (!hasText(payload.buyer?.name)) errors.push(`invoice ${invoiceNumber} is missing buyer.name required for OIOUBL handoff`);
  if (!hasText(payload.buyer?.address)) errors.push(`invoice ${invoiceNumber} is missing buyer.address required for OIOUBL handoff`);
  if (!eanNumber) errors.push(`invoice ${invoiceNumber} is missing buyer.eanNumber as 13 digits required for OIOUBL handoff`);
  if (!hasText(payload.currency)) errors.push(`invoice ${invoiceNumber} is missing currency required for OIOUBL handoff`);
  if (typeof payload.totals?.netAmount !== "number") errors.push(`invoice ${invoiceNumber} is missing totals.netAmount required for OIOUBL handoff`);
  if (typeof payload.totals?.grossAmount !== "number") errors.push(`invoice ${invoiceNumber} is missing totals.grossAmount required for OIOUBL handoff`);
  if (typeof payload.totals?.vatAmount !== "number") errors.push(`invoice ${invoiceNumber} is missing totals.vatAmount required for OIOUBL handoff`);
  if (typeof payload.totals?.vatRate !== "number") errors.push(`invoice ${invoiceNumber} is missing totals.vatRate required for OIOUBL handoff`);
  if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
    errors.push(`invoice ${invoiceNumber} is missing invoice lines required for OIOUBL handoff`);
  } else {
    payload.lines.forEach((line, index) => {
      if (!hasText(line.description)) errors.push(`invoice ${invoiceNumber} line ${index + 1} is missing description required for OIOUBL handoff`);
      if (typeof line.quantity !== "number") errors.push(`invoice ${invoiceNumber} line ${index + 1} is missing quantity required for OIOUBL handoff`);
      if (typeof line.unitPriceExVat !== "number") errors.push(`invoice ${invoiceNumber} line ${index + 1} is missing unitPriceExVat required for OIOUBL handoff`);
      if (typeof line.lineTotalExVat !== "number") errors.push(`invoice ${invoiceNumber} line ${index + 1} is missing lineTotalExVat required for OIOUBL handoff`);
    });
  }
  return errors;
}

function buildPublicEInvoiceOioUblXml(invoiceNumber: string, payload: InvoicePayload) {
  const currency = (payload.currency ?? "DKK").trim().toUpperCase();
  const vatPercent = formatVatPercent(payload.totals?.vatRate);
  const lines = payload.lines ?? [];
  const lineXml = lines
    .map((line, index) => [
      "  <cac:InvoiceLine>",
      xmlTag("cbc:ID", index + 1, "    "),
      xmlTagWithAttrs("cbc:InvoicedQuantity", { unitCode: "H87" }, line.quantity, "    "),
      xmlTagWithAttrs("cbc:LineExtensionAmount", { currencyID: currency }, formatAmount(line.lineTotalExVat), "    "),
      "    <cac:Item>",
      xmlTag("cbc:Name", line.description, "      "),
      "      <cac:ClassifiedTaxCategory>",
      xmlTag("cbc:ID", "S", "        "),
      xmlTag("cbc:Percent", vatPercent, "        "),
      "        <cac:TaxScheme>",
      xmlTag("cbc:ID", "VAT", "          "),
      "        </cac:TaxScheme>",
      "      </cac:ClassifiedTaxCategory>",
      "    </cac:Item>",
      "    <cac:Price>",
      xmlTagWithAttrs("cbc:PriceAmount", { currencyID: currency }, formatAmount(line.unitPriceExVat), "      "),
      "    </cac:Price>",
      "  </cac:InvoiceLine>",
    ].filter(Boolean).join("\n"))
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
    xmlTag("cbc:UBLVersionID", OIOUBL_UBL_VERSION, "  "),
    xmlTag("cbc:CustomizationID", OIOUBL_CUSTOMIZATION_ID, "  "),
    xmlTag("cbc:ProfileID", OIOUBL_PROFILE_ID, "  "),
    xmlTag("cbc:ID", invoiceNumber, "  "),
    xmlTag("cbc:IssueDate", payload.issueDate, "  "),
    xmlTag("cbc:DueDate", payload.dueDate, "  "),
    xmlTag("cbc:InvoiceTypeCode", "380", "  "),
    xmlTag("cbc:DocumentCurrencyCode", currency, "  "),
    "  <cac:AccountingSupplierParty>",
    "    <cac:Party>",
    "      <cac:PartyName>",
    xmlTag("cbc:Name", payload.seller?.name, "        "),
    "      </cac:PartyName>",
    buildAddressXml("cac:PostalAddress", payload.seller?.address, "      "),
    "      <cac:PartyTaxScheme>",
    xmlTag("cbc:CompanyID", payload.seller?.vatOrCvr, "        "),
    "        <cac:TaxScheme>",
    xmlTag("cbc:ID", "VAT", "          "),
    "        </cac:TaxScheme>",
    "      </cac:PartyTaxScheme>",
    "      <cac:PartyLegalEntity>",
    xmlTag("cbc:RegistrationName", payload.seller?.name, "        "),
    xmlTag("cbc:CompanyID", payload.seller?.vatOrCvr, "        "),
    "      </cac:PartyLegalEntity>",
    "    </cac:Party>",
    "  </cac:AccountingSupplierParty>",
    "  <cac:AccountingCustomerParty>",
    "    <cac:Party>",
    xmlTagWithAttrs("cbc:EndpointID", { schemeID: "0188" }, payload.buyer?.eanNumber, "      "),
    "      <cac:PartyName>",
    xmlTag("cbc:Name", payload.buyer?.name, "        "),
    "      </cac:PartyName>",
    buildAddressXml("cac:PostalAddress", payload.buyer?.address, "      "),
    "    </cac:Party>",
    "  </cac:AccountingCustomerParty>",
    "  <cac:TaxTotal>",
    xmlTagWithAttrs("cbc:TaxAmount", { currencyID: currency }, formatAmount(payload.totals?.vatAmount), "    "),
    "    <cac:TaxSubtotal>",
    xmlTagWithAttrs("cbc:TaxableAmount", { currencyID: currency }, formatAmount(payload.totals?.netAmount), "      "),
    xmlTagWithAttrs("cbc:TaxAmount", { currencyID: currency }, formatAmount(payload.totals?.vatAmount), "      "),
    "      <cac:TaxCategory>",
    xmlTag("cbc:ID", "S", "        "),
    xmlTag("cbc:Percent", vatPercent, "        "),
    "        <cac:TaxScheme>",
    xmlTag("cbc:ID", "VAT", "          "),
    "        </cac:TaxScheme>",
    "      </cac:TaxCategory>",
    "    </cac:TaxSubtotal>",
    "  </cac:TaxTotal>",
    "  <cac:LegalMonetaryTotal>",
    xmlTagWithAttrs("cbc:LineExtensionAmount", { currencyID: currency }, formatAmount(payload.totals?.netAmount), "    "),
    xmlTagWithAttrs("cbc:TaxExclusiveAmount", { currencyID: currency }, formatAmount(payload.totals?.netAmount), "    "),
    xmlTagWithAttrs("cbc:TaxInclusiveAmount", { currencyID: currency }, formatAmount(payload.totals?.grossAmount), "    "),
    xmlTagWithAttrs("cbc:PayableAmount", { currencyID: currency }, formatAmount(payload.totals?.grossAmount), "    "),
    "  </cac:LegalMonetaryTotal>",
    lineXml,
    "</Invoice>",
    "",
  ].filter((line) => line !== "").join("\n");
}

function loadExportedInvoice(db: Database, input: ExportPublicEInvoiceInput) {
  return db.query(
    `SELECT id, invoice_no, invoice_date, document_type, payload_json
     FROM documents
     WHERE id = ? LIMIT 1`,
  ).get(input.invoiceDocumentId) as ExportedInvoiceRow | null;
}

export function exportPublicEInvoicePreview(
  db: Database,
  input: ExportPublicEInvoiceInput,
): ExportPublicEInvoiceResult {
  const row = loadExportedInvoice(db, input);

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

export function exportPublicEInvoiceOioUbl(
  db: Database,
  input: ExportPublicEInvoiceInput,
): ExportPublicEInvoiceResult {
  const row = loadExportedInvoice(db, input);

  if (!row) {
    return { ok: false, appliedRules: [OIOUBL_RULE_ID], errors: [`invoice ${input.invoiceDocumentId} was not found`] };
  }
  if (row.document_type !== "issued_invoice") {
    return { ok: false, appliedRules: [OIOUBL_RULE_ID], errors: [`document ${input.invoiceDocumentId} is not an issued invoice`] };
  }
  if (!row.payload_json) {
    return { ok: false, appliedRules: [OIOUBL_RULE_ID], errors: [`invoice ${row.invoice_no ?? input.invoiceDocumentId} is missing payload_json`] };
  }

  const payload = JSON.parse(row.payload_json) as InvoicePayload & { invoiceNumber?: string };
  const invoiceNumber = payload.invoiceNumber ?? row.invoice_no ?? String(input.invoiceDocumentId);
  const eanNumber = normalizeEanNumber(payload.buyer?.eanNumber);

  if (payload.buyer?.publicRecipient !== true && !eanNumber) {
    return {
      ok: false,
      appliedRules: [OIOUBL_RULE_ID],
      errors: [`invoice ${invoiceNumber} is not marked as a public-recipient e-invoice`],
    };
  }

  const normalizedPayload: InvoicePayload = {
    ...payload,
    currency: (payload.currency ?? "DKK").trim().toUpperCase(),
    buyer: {
      ...payload.buyer,
      eanNumber: eanNumber ?? undefined,
      publicRecipient: true,
    },
  };

  const errors = validateOioUblPayload(invoiceNumber, normalizedPayload, eanNumber);
  if (errors.length > 0) {
    return {
      ok: false,
      appliedRules: [OIOUBL_RULE_ID],
      errors,
    };
  }

  const xml = buildPublicEInvoiceOioUblXml(invoiceNumber, normalizedPayload);
  const sha256 = createHash("sha256").update(xml).digest("hex");
  if (input.outPath) writeFileSync(input.outPath, xml);
  insertAuditLog(db, {
    eventType: "public_einvoice_oioubl_export",
    entityType: "document",
    entityId: row.id,
    message: `Generated public OIOUBL handoff artifact for invoice ${invoiceNumber} (sha256 ${sha256})`,
  });

  return {
    ok: true,
    invoiceNumber,
    outPath: input.outPath,
    sha256,
    xml,
    appliedRules: [OIOUBL_RULE_ID],
    errors: [],
  };
}
