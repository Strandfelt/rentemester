import { isValidIsoDate as looksLikeIsoDate } from "./dates";
import { roundDkk } from "./money";
export type InvoiceType = "full" | "simplified";
export type VatTreatment = "standard" | "domestic_reverse_charge" | "foreign_reverse_charge";
export type ReverseChargeBasis =
  | "DK_MOMSLOVEN_§46_STK_1_NR_3"
  | "DK_MOMSLOVEN_§46_STK_1_NR_6"
  | "DK_MOMSLOVEN_§46_STK_1_NR_7"
  | "EU_MOMSDIREKTIV_ART_196"
  | "EU_MOMSDIREKTIV_ART_199";

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
  reverseChargeBasis?: ReverseChargeBasis;
  reverseChargeNote?: string;
  currency?: string;
  dueDate?: string;
  deliveryDate?: string;
  deliveryPeriodStart?: string;
  deliveryPeriodEnd?: string;
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
  REVERSE_CHARGE_BASIS: "DK-INVOICE-REVERSE-CHARGE-BASIS-001",
  DELIVERY_DATE: "DK-INVOICE-DELIVERY-DATE-001",
  ARITHMETIC: "DK-INVOICE-ARITHMETIC-001",
  VAT_SEPARATE_AMOUNT: "DK-VAT-SEPARATE-AMOUNT-001",
} as const;

const FOREIGN_REVERSE_CHARGE_BASES: ReverseChargeBasis[] = [
  "DK_MOMSLOVEN_§46_STK_1_NR_3",
  "EU_MOMSDIREKTIV_ART_196",
  "EU_MOMSDIREKTIV_ART_199",
];
const DOMESTIC_REVERSE_CHARGE_BASES: ReverseChargeBasis[] = [
  "DK_MOMSLOVEN_§46_STK_1_NR_6",
  "DK_MOMSLOVEN_§46_STK_1_NR_7",
];

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}


function hasLineDescriptions(lines: InvoicePayload["lines"]) {
  return Array.isArray(lines) && lines.length > 0 && lines.every((line) => hasText(line.description));
}


export function validateInvoice(payload: InvoicePayload): InvoiceValidationResult {
  const errors: string[] = [];
  const invoiceType = payload.invoiceType;
  const vatTreatment = payload.vatTreatment ?? "standard";
  const appliedRules = [invoiceType === "simplified" ? RULES.SIMPLIFIED : RULES.FULL, RULES.ARITHMETIC];

  if (!looksLikeIsoDate(payload.issueDate)) errors.push("issueDate must be present in YYYY-MM-DD format");
  if (payload.dueDate !== undefined && !looksLikeIsoDate(payload.dueDate)) errors.push("dueDate must be YYYY-MM-DD when present");
  if (looksLikeIsoDate(payload.issueDate) && looksLikeIsoDate(payload.dueDate) && payload.dueDate < payload.issueDate) {
    errors.push("dueDate cannot be earlier than issueDate");
  }
  appliedRules.push(RULES.DELIVERY_DATE);
  if (payload.deliveryDate !== undefined && !looksLikeIsoDate(payload.deliveryDate)) {
    errors.push("deliveryDate must be YYYY-MM-DD when present");
  }
  if (payload.deliveryPeriodStart !== undefined && !looksLikeIsoDate(payload.deliveryPeriodStart)) {
    errors.push("deliveryPeriodStart must be YYYY-MM-DD when present");
  }
  if (payload.deliveryPeriodEnd !== undefined && !looksLikeIsoDate(payload.deliveryPeriodEnd)) {
    errors.push("deliveryPeriodEnd must be YYYY-MM-DD when present");
  }
  const hasDeliveryPeriodStart = payload.deliveryPeriodStart !== undefined;
  const hasDeliveryPeriodEnd = payload.deliveryPeriodEnd !== undefined;
  if (hasDeliveryPeriodStart !== hasDeliveryPeriodEnd) {
    errors.push("deliveryPeriodStart and deliveryPeriodEnd must be provided together");
  }
  if (payload.deliveryDate !== undefined && (hasDeliveryPeriodStart || hasDeliveryPeriodEnd)) {
    errors.push("use either deliveryDate or deliveryPeriodStart/deliveryPeriodEnd, not both");
  }
  if (looksLikeIsoDate(payload.deliveryPeriodStart) && looksLikeIsoDate(payload.deliveryPeriodEnd) && payload.deliveryPeriodEnd < payload.deliveryPeriodStart) {
    errors.push("deliveryPeriodEnd cannot be earlier than deliveryPeriodStart");
  }
  if (payload.invoiceNumber !== undefined && !hasText(payload.invoiceNumber)) errors.push("invoiceNumber must not be blank when present");
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
    appliedRules.push(RULES.VAT_SEPARATE_AMOUNT);
    if (!hasPositiveNumber(payload.totals?.vatRate) || (payload.totals?.vatRate ?? 0) <= 0) {
      errors.push("standard VAT invoices must include totals.vatRate");
    }
    if (!hasPositiveNumber(payload.totals?.vatAmount) || (payload.totals?.vatAmount ?? 0) <= 0) {
      errors.push("standard VAT invoices must include totals.vatAmount");
    }
  }

  if (vatTreatment === "domestic_reverse_charge" || vatTreatment === "foreign_reverse_charge") {
    appliedRules.push(RULES.REVERSE_CHARGE, RULES.REVERSE_CHARGE_BASIS);
    if (!hasText(payload.reverseChargeBasis)) {
      errors.push("reverse-charge invoices must include reverseChargeBasis");
    }
    if (payload.totals?.vatRate !== undefined) {
      errors.push("reverse-charge invoices must not include totals.vatRate");
    }
    if (payload.totals?.vatAmount !== undefined) {
      errors.push("reverse-charge invoices must not include totals.vatAmount");
    }
    if (vatTreatment === "foreign_reverse_charge") {
      if (!hasText(payload.buyer?.vatOrCvr)) {
        errors.push("foreign reverse-charge invoices must include buyer.vatOrCvr");
      }
      if (hasText(payload.reverseChargeBasis) && !FOREIGN_REVERSE_CHARGE_BASES.includes(payload.reverseChargeBasis)) {
        errors.push(`reverseChargeBasis ${payload.reverseChargeBasis} is not valid for foreign reverse-charge invoices`);
      }
    }
    if (vatTreatment === "domestic_reverse_charge" && hasText(payload.reverseChargeBasis) && !DOMESTIC_REVERSE_CHARGE_BASES.includes(payload.reverseChargeBasis)) {
      errors.push(`reverseChargeBasis ${payload.reverseChargeBasis} is not valid for domestic reverse-charge invoices`);
    }
  }

  if (Array.isArray(payload.lines)) {
    for (const [index, line] of payload.lines.entries()) {
      const qty = line.quantity;
      const unit = line.unitPriceExVat;
      const total = line.lineTotalExVat;
      if (typeof qty === "number" && typeof unit === "number" && typeof total === "number") {
        const expected = roundDkk(qty * unit);
        if (roundDkk(total) !== expected) {
          errors.push(`lines[${index}].lineTotalExVat must equal quantity * unitPriceExVat (${expected})`);
        }
      }
    }
  }

  const lineSum = Array.isArray(payload.lines)
    ? roundDkk(payload.lines.reduce((sum, line) => sum + Number(line.lineTotalExVat ?? 0), 0))
    : 0;
  const netAmount = roundDkk(Number(payload.totals?.netAmount ?? 0));
  const vatAmount = roundDkk(Number(payload.totals?.vatAmount ?? 0));
  const grossAmount = roundDkk(Number(payload.totals?.grossAmount ?? 0));

  if (invoiceType === "full" && Array.isArray(payload.lines) && payload.lines.every((line) => typeof line.lineTotalExVat === "number")) {
    if (netAmount !== lineSum) errors.push(`totals.netAmount must equal sum of lineTotalExVat (${lineSum})`);
  }

  if (vatTreatment === "standard" && (invoiceType === "full" || payload.totals?.netAmount !== undefined)) {
    const expectedGross = roundDkk(netAmount + vatAmount);
    if (grossAmount !== expectedGross) {
      errors.push(`totals.grossAmount must equal totals.netAmount + totals.vatAmount (${expectedGross})`);
    }
  }

  if ((vatTreatment === "domestic_reverse_charge" || vatTreatment === "foreign_reverse_charge") && payload.totals?.netAmount !== undefined) {
    if (grossAmount !== netAmount) {
      errors.push(`reverse-charge invoices must have totals.grossAmount equal totals.netAmount (${netAmount})`);
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
