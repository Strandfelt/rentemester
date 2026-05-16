export type InvoiceType = "full" | "simplified";
export type VatTreatment = "standard" | "domestic_reverse_charge" | "foreign_reverse_charge";

export type InvoicePayload = {
  invoiceType: InvoiceType;
  vatTreatment?: VatTreatment;
  issueDate?: string;
  invoiceNumber?: string;
  seller?: { name?: string; address?: string; vatOrCvr?: string };
  buyer?: { name?: string; address?: string; vatOrCvr?: string };
  lines?: Array<{ description?: string; quantity?: number; unitPriceExVat?: number; lineTotalExVat?: number }>;
  totals?: {
    netAmount?: number;
    vatRate?: number;
    vatAmount?: number;
    grossAmount?: number;
    vatComputationBasis?: "VAT_20_OF_GROSS" | string;
  };
  reverseChargeNote?: string;
  currency?: string;
};

export type InvoiceValidationResult = {
  ok: boolean;
  invoiceType: InvoiceType;
  vatTreatment: VatTreatment;
  appliedRules: string[];
  errors: string[];
};

const RULES = {
  FULL: "DK-INVOICE-FULL-001",
  SIMPLIFIED: "DK-INVOICE-SIMPLIFIED-001",
  REVERSE_CHARGE: "DK-INVOICE-REVERSE-CHARGE-001",
} as const;

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function looksLikeIsoDate(value: unknown) {
  return hasText(value) && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function hasLineDescriptions(lines: InvoicePayload["lines"]) {
  return Array.isArray(lines) && lines.length > 0 && lines.every((line) => hasText(line.description));
}

export function validateInvoice(payload: InvoicePayload): InvoiceValidationResult {
  const errors: string[] = [];
  const invoiceType = payload.invoiceType;
  const vatTreatment = payload.vatTreatment ?? "standard";
  const appliedRules = [invoiceType === "simplified" ? RULES.SIMPLIFIED : RULES.FULL];

  if (!looksLikeIsoDate(payload.issueDate)) errors.push("issueDate must be present in YYYY-MM-DD format");
  if (!hasText(payload.invoiceNumber)) errors.push("invoiceNumber is required");
  if (!hasText(payload.seller?.name)) errors.push("seller.name is required");
  if (!hasText(payload.seller?.address)) errors.push("seller.address is required");
  if (!hasText(payload.seller?.vatOrCvr)) errors.push("seller.vatOrCvr is required");
  if (!hasLineDescriptions(payload.lines)) errors.push("lines must contain at least one described good or service");
  if (!hasPositiveNumber(payload.totals?.grossAmount)) errors.push("totals.grossAmount is required");

  if (invoiceType === "full") {
    if (!hasText(payload.buyer?.name)) errors.push("buyer.name is required for full invoices");
    if (!hasText(payload.buyer?.address)) errors.push("buyer.address is required for full invoices");
    if (!hasPositiveNumber(payload.totals?.netAmount)) errors.push("totals.netAmount is required for full invoices");
  }

  if (invoiceType === "simplified") {
    if ((payload.totals?.grossAmount ?? Number.POSITIVE_INFINITY) > 3000) {
      errors.push("simplified invoices are only allowed up to DKK 3,000 gross");
    }
    const hasVatAmount = hasPositiveNumber(payload.totals?.vatAmount) && (payload.totals?.vatAmount ?? 0) > 0;
    const has20PctBasis = payload.totals?.vatComputationBasis === "VAT_20_OF_GROSS";
    if (!hasVatAmount && !has20PctBasis) {
      errors.push("simplified invoices must include vatAmount or VAT_20_OF_GROSS computation basis");
    }
  }

  if (vatTreatment === "standard") {
    if (!hasPositiveNumber(payload.totals?.vatRate) || (payload.totals?.vatRate ?? 0) <= 0) {
      errors.push("standard VAT invoices must include totals.vatRate");
    }
    if (!hasPositiveNumber(payload.totals?.vatAmount) || (payload.totals?.vatAmount ?? 0) <= 0) {
      errors.push("standard VAT invoices must include totals.vatAmount");
    }
  }

  if (vatTreatment === "domestic_reverse_charge" || vatTreatment === "foreign_reverse_charge") {
    appliedRules.push(RULES.REVERSE_CHARGE);
    if (!hasText(payload.reverseChargeNote)) {
      errors.push("reverse-charge invoices must include reverseChargeNote");
    }
    if (payload.totals?.vatRate !== undefined) {
      errors.push("reverse-charge invoices must not include totals.vatRate");
    }
    if (payload.totals?.vatAmount !== undefined) {
      errors.push("reverse-charge invoices must not include totals.vatAmount");
    }
    if (vatTreatment === "foreign_reverse_charge" && !hasText(payload.buyer?.vatOrCvr)) {
      errors.push("foreign reverse-charge invoices must include buyer.vatOrCvr");
    }
  }

  if ((payload.currency ?? "DKK") !== "DKK") {
    errors.push("only DKK invoices are supported in the current deterministic validator");
  }

  return {
    ok: errors.length === 0,
    invoiceType,
    vatTreatment,
    appliedRules,
    errors,
  };
}
