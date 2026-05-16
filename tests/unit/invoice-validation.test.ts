import { describe, expect, test } from "bun:test";
import { validateInvoice } from "../../src/core/invoice";

describe("invoice validator", () => {
  test("accepts a compliant full Danish VAT invoice", () => {
    const result = validateInvoice({
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0042",
      seller: { name: "Rentemester ApS", address: "Testvej 1, 2100 København Ø", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9, 8000 Aarhus C" },
      lines: [{ description: "Bogføring og momsopsætning", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK",
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.appliedRules).toContain("DK-INVOICE-FULL-001");
  });

  test("rejects simplified invoice above the DKK 3,000 limit", () => {
    const result = validateInvoice({
      invoiceType: "simplified",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0043",
      seller: { name: "Rentemester ApS", address: "Testvej 1, 2100 København Ø", vatOrCvr: "DK12345678" },
      lines: [{ description: "Kvitteringssalg" }],
      totals: { grossAmount: 3000.01, vatAmount: 600.01, vatRate: 0.25 },
      currency: "DKK",
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("simplified invoices are only allowed up to DKK 3,000 gross");
  });

  test("accepts simplified invoice when VAT is computable as 20 percent of gross", () => {
    const result = validateInvoice({
      invoiceType: "simplified",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0044",
      seller: { name: "Rentemester ApS", address: "Testvej 1, 2100 København Ø", vatOrCvr: "DK12345678" },
      lines: [{ description: "Kontant salg" }],
      totals: { grossAmount: 1250, vatRate: 0.25, vatAmount: 250, vatComputationBasis: "VAT_20_OF_GROSS" },
      currency: "DKK",
    });

    expect(result.ok).toBe(true);
    expect(result.appliedRules).toContain("DK-INVOICE-SIMPLIFIED-001");
  });

  test("rejects reverse-charge invoice with VAT amount and missing note", () => {
    const result = validateInvoice({
      invoiceType: "full",
      vatTreatment: "foreign_reverse_charge",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0045",
      seller: { name: "Rentemester ApS", address: "Testvej 1, 2100 København Ø", vatOrCvr: "DK12345678" },
      buyer: { name: "EU Kunde GmbH", address: "Berlin", vatOrCvr: "DE123456789" },
      lines: [{ description: "AI consulting" }],
      totals: { netAmount: 8000, vatAmount: 2000, grossAmount: 8000 },
      currency: "DKK",
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("reverse-charge invoices must include reverseChargeNote");
    expect(result.errors).toContain("reverse-charge invoices must not include totals.vatAmount");
    expect(result.appliedRules).toContain("DK-INVOICE-REVERSE-CHARGE-001");
  });
});
