import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
import { issueCreditNote } from "../../src/core/credit-notes";
import { seedAccounts, verifyAuditChain } from "../../src/core/ledger";
import { postIssuedInvoiceToLedger } from "../../src/core/invoice-booking";

describe("credit notes", () => {
  test("mirrors original invoice posting accounts when crediting a custom-booked invoice", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-credit-custom-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);
    db.run("INSERT OR IGNORE INTO accounts (account_no, name, type, normal_balance, default_vat_code) VALUES ('1001', 'Abonnementsomsætning', 'income', 'credit', NULL)");
    db.run("INSERT OR IGNORE INTO accounts (account_no, name, type, normal_balance, default_vat_code) VALUES ('1101', 'Debitorer abonnement', 'asset', 'debit', NULL)");
    db.run("INSERT OR IGNORE INTO accounts (account_no, name, type, normal_balance, default_vat_code) VALUES ('1201', 'Salgsmoms abonnement', 'vat', 'credit', NULL)");

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0950A",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Abonnement", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    expect(postIssuedInvoiceToLedger(db, {
      invoiceDocumentId: issued.documentId!,
      receivableAccountNo: "1101",
      revenueAccountNo: "1001",
      outputVatAccountNo: "1201"
    }).ok).toBe(true);

    const credit = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-17",
      reason: "Partial correction",
      grossAmount: 625
    });
    expect(credit.ok).toBe(true);

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(credit.journalEntryId!) as any[];
    expect(lines).toEqual([
      { account_no: "1101", debit_amount: 0, credit_amount: 625, vat_code: null },
      { account_no: "1001", debit_amount: 500, credit_amount: 0, vat_code: "DK_SALE_25" },
      { account_no: "1201", debit_amount: 125, credit_amount: 0, vat_code: null },
    ]);

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("issues partial credit notes up to the original invoice amount and posts reversing sales lines", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-credit-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0950",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);

    const credit = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-17",
      reason: "Partial correction",
      grossAmount: 625
    });
    expect(credit.ok).toBe(true);
    expect(credit.appliedRules).toContain("DK-CREDIT-NOTE-001");
    expect(existsSync(credit.storedPath!)).toBe(true);

    const doc = db.query("SELECT document_type, invoice_no, payment_details FROM documents WHERE id = ?").get(credit.documentId!) as any;
    expect(doc.document_type).toBe("credit_note");
    expect(doc.payment_details).toBe("2026-0950");

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(credit.journalEntryId!) as any[];
    expect(lines).toEqual([
      { account_no: "1000", debit_amount: 500, credit_amount: 0, vat_code: "DK_SALE_25" },
      { account_no: "1200", debit_amount: 125, credit_amount: 0, vat_code: null },
      { account_no: "1100", debit_amount: 0, credit_amount: 625, vat_code: null },
    ]);

    const second = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-18",
      reason: "Final correction"
    });
    expect(second.ok).toBe(true);

    const third = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-19",
      reason: "Too much",
      grossAmount: 1
    });
    expect(third.ok).toBe(false);
    expect(third.errors[0]).toContain("already fully credited");

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
