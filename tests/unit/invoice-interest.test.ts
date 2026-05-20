import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
import { applyInvoicePayment, getInvoiceStatus } from "../../src/core/invoice-payments";
import { calculateInvoiceLateInterest, postInvoiceLateInterestToLedger, registerInvoiceLateInterest } from "../../src/core/invoice-interest";
import { seedAccounts, verifyAuditChain } from "../../src/core/ledger";

function failingInterestPostingDb(realDb: any) {
  let failed = false;
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "run") {
        return (sql: string, ...args: any[]) => {
          if (!failed && typeof sql === "string" && sql.includes("INSERT INTO invoice_interest_postings")) {
            failed = true;
            throw new Error("simulated interest posting link failure");
          }
          return target.run(sql, ...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as any;
}

describe("invoice late interest", () => {
  test("calculates statutory late interest on overdue open balance", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-interest-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      dueDate: "2026-06-15",
      invoiceNumber: "2026-0900",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    expect(applyInvoicePayment(db, {
      invoiceDocumentId: issued.documentId!,
      paymentDate: "2026-05-20",
      amount: 1000,
      note: "Partial payment"
    }).ok).toBe(true);

    const interest = calculateInvoiceLateInterest(db, {
      invoiceDocumentId: issued.documentId!,
      asOfDate: "2026-06-20",
      referenceRatePercent: 2.2,
    });
    expect(interest.ok).toBe(true);
    expect(interest.overdueDays).toBe(5);
    expect(interest.principalOpenBalance).toBe(250);
    expect(interest.annualInterestRatePercent).toBe(10.2);
    expect(interest.accruedInterestAmount).toBe(0.35);
    expect(interest.appliedRules).toContain("DK-INVOICE-LATE-INTEREST-001");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("registers immutable late-interest claims and surfaces them in claim balance", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-interest-register-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      dueDate: "2026-06-15",
      invoiceNumber: "2026-0900B",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    expect(applyInvoicePayment(db, {
      invoiceDocumentId: issued.documentId!,
      paymentDate: "2026-05-20",
      amount: 1000,
      note: "Partial payment"
    }).ok).toBe(true);

    const registered = registerInvoiceLateInterest(db, {
      invoiceDocumentId: issued.documentId!,
      asOfDate: "2026-06-20",
      referenceRatePercent: 2.2,
      note: "First registered interest"
    });
    expect(registered.ok).toBe(true);
    expect(registered.claimId).toBeDefined();
    expect(registered.accruedInterestAmount).toBe(0.35);
    expect(registered.claimOpenBalance).toBe(250.35);
    expect(registered.appliedRules).toContain("DK-INVOICE-LATE-INTEREST-REGISTER-001");

    const status = getInvoiceStatus(db, issued.documentId!, "2026-06-20");
    expect(status.ok).toBe(true);
    expect(status.totalInterestClaims).toBe(0.35);
    expect(status.claimOpenBalance).toBe(250.35);
    expect(status.interestClaims).toHaveLength(1);
    expect(status.interestClaims?.[0]?.amountDkk).toBe(0.35);
    expect(status.interestClaims?.[0]?.journalEntryId).toBe(null);

    const duplicate = registerInvoiceLateInterest(db, {
      invoiceDocumentId: issued.documentId!,
      asOfDate: "2026-06-20",
      referenceRatePercent: 2.2,
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.errors[0]).toContain("already registered");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("refuses a second open interest claim so overlapping periods are not double-charged", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-interest-double-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      dueDate: "2026-06-15",
      invoiceNumber: "2026-0900E",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    expect(applyInvoicePayment(db, {
      invoiceDocumentId: issued.documentId!,
      paymentDate: "2026-05-20",
      amount: 1000,
      note: "Partial payment"
    }).ok).toBe(true);

    const first = registerInvoiceLateInterest(db, {
      invoiceDocumentId: issued.documentId!,
      asOfDate: "2026-06-20",
      referenceRatePercent: 2.2,
    });
    expect(first.ok).toBe(true);

    // A later as-of date recomputes interest over the FULL window from the due
    // date, so registering it again would re-bill the first 5 overdue days.
    const second = registerInvoiceLateInterest(db, {
      invoiceDocumentId: issued.documentId!,
      asOfDate: "2026-07-20",
      referenceRatePercent: 2.2,
    });
    expect(second.ok).toBe(false);
    expect(second.errors[0]).toContain("open");

    const status = getInvoiceStatus(db, issued.documentId!, "2026-07-20");
    expect(status.interestClaims).toHaveLength(1);
    expect(status.totalInterestClaims).toBe(0.35);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("posts a registered late-interest claim once to receivables and non-VAT claim income", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-interest-post-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      dueDate: "2026-06-15",
      invoiceNumber: "2026-0900C",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    expect(applyInvoicePayment(db, {
      invoiceDocumentId: issued.documentId!,
      paymentDate: "2026-05-20",
      amount: 1000,
      note: "Partial payment"
    }).ok).toBe(true);
    expect(registerInvoiceLateInterest(db, {
      invoiceDocumentId: issued.documentId!,
      asOfDate: "2026-06-20",
      referenceRatePercent: 2.2,
      note: "First registered interest"
    }).ok).toBe(true);

    const posted = postInvoiceLateInterestToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(posted.ok).toBe(true);
    expect(posted.accruedInterestAmount).toBe(0.35);
    expect(posted.appliedRules).toContain("DK-INVOICE-LATE-INTEREST-BOOKKEEPING-001");

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(posted.entryId!) as any[];
    expect(lines).toEqual([
      { account_no: "1100", debit_amount: 0.35, credit_amount: 0, vat_code: null },
      { account_no: "1010", debit_amount: 0, credit_amount: 0.35, vat_code: null },
    ]);

    const status = getInvoiceStatus(db, issued.documentId!, "2026-06-20");
    expect(status.ok).toBe(true);
    expect(status.interestClaims?.[0]?.journalEntryId).toBe(posted.entryId);

    const second = postInvoiceLateInterestToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(second.ok).toBe(false);
    expect(second.errors[0]).toContain("already posted");

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rolls back the journal entry if interest posting link creation fails", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-interest-atomic-"));
    const realDb = openDb(ensureCompanyDirs(root).db);
    migrate(realDb);
    seedAccounts(realDb);
    const db = failingInterestPostingDb(realDb);

    const issued = issueInvoice(realDb, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      dueDate: "2026-06-15",
      invoiceNumber: "2026-0900D",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    expect(applyInvoicePayment(realDb, {
      invoiceDocumentId: issued.documentId!,
      paymentDate: "2026-05-20",
      amount: 1000,
      note: "Partial payment"
    }).ok).toBe(true);
    expect(registerInvoiceLateInterest(realDb, {
      invoiceDocumentId: issued.documentId!,
      asOfDate: "2026-06-20",
      referenceRatePercent: 2.2,
    }).ok).toBe(true);

    const failed = postInvoiceLateInterestToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(failed.ok).toBe(false);
    expect(failed.errors[0]).toContain("simulated interest posting link failure");
    expect(realDb.query("SELECT COUNT(*) AS n FROM journal_entries").get()).toEqual({ n: 1 });
    expect(realDb.query("SELECT COUNT(*) AS n FROM invoice_interest_postings").get()).toEqual({ n: 0 });

    const retry = postInvoiceLateInterestToLedger(realDb, { invoiceDocumentId: issued.documentId! });
    expect(retry.ok).toBe(true);
    expect(realDb.query("SELECT COUNT(*) AS n FROM journal_entries").get()).toEqual({ n: 2 });
    expect(realDb.query("SELECT COUNT(*) AS n FROM invoice_interest_postings").get()).toEqual({ n: 1 });

    realDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("returns zero interest for non-overdue or fully settled invoices", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-interest-zero-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      dueDate: "2026-06-15",
      invoiceNumber: "2026-0901",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);

    const interest = calculateInvoiceLateInterest(db, {
      invoiceDocumentId: issued.documentId!,
      asOfDate: "2026-06-10",
      referenceRatePercent: 2.2,
    });
    expect(interest.ok).toBe(true);
    expect(interest.overdueDays).toBe(0);
    expect(interest.accruedInterestAmount).toBe(0);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
