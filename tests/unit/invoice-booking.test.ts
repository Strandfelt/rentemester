import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
import { postIssuedInvoiceToLedger } from "../../src/core/invoice-booking";
import { seedAccounts, verifyAuditChain } from "../../src/core/ledger";
import { buildVatReport } from "../../src/core/vat";
import { storeViesValidation } from "../../src/core/vies";

describe("invoice ledger posting", () => {
  test("posts reverse-charge invoice without an output-VAT line", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicebook-reverse-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);
    storeViesValidation(db, {
      vatOrCvr: "DE123456789",
      valid: true,
      validatedAt: "2026-05-15T00:00:00.000Z",
      expiresAt: "2026-08-15T00:00:00.000Z",
      rawResponse: JSON.stringify({ valid: true })
    });

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "foreign_reverse_charge",
      reverseChargeBasis: "EU_MOMSDIREKTIV_ART_196",
      reverseChargeNote: "Reverse charge",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0800RC",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde GmbH", address: "Berlin", vatOrCvr: "DE123456789" },
      lines: [{ description: "Consulting", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, grossAmount: 1000 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);

    const posted = postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(posted.ok).toBe(true);
    expect(posted.appliedRules).toContain("DK-INVOICE-BOOKKEEPING-001");
    expect(posted.appliedRules).toContain("DK-INVOICE-BOOKKEEPING-REVERSE-002");

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(posted.entryId!) as any[];
    expect(lines).toEqual([
      { account_no: "1100", debit_amount: 1000, credit_amount: 0, vat_code: null },
      { account_no: "1000", debit_amount: 0, credit_amount: 1000, vat_code: "REVERSE_CHARGE_EXEMPT" },
    ]);

    const vat = buildVatReport(db, "2026-05-01", "2026-05-31");
    expect(vat.ok).toBe(true);
    expect(vat.outputVat).toBe(0);
    expect(vat.salesBase25).toBe(0);
    expect(vat.reverseChargeSalesBase).toBe(1000);
    expect(vat.warnings).toEqual([]);

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("posts issued invoice once to receivables, revenue, and output VAT", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicebook-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0800",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);

    const posted = postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(posted.ok).toBe(true);
    expect(posted.appliedRules).toContain("DK-INVOICE-BOOKKEEPING-001");

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(posted.entryId!) as any[];
    expect(lines).toEqual([
      { account_no: "1100", debit_amount: 1250, credit_amount: 0, vat_code: null },
      { account_no: "1000", debit_amount: 0, credit_amount: 1000, vat_code: "DK_SALE_25" },
      { account_no: "1200", debit_amount: 0, credit_amount: 250, vat_code: null },
    ]);

    const second = postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(second.ok).toBe(false);
    expect(second.errors[0]).toContain("already has journal entry");

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
