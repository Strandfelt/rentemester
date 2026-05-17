import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { ingestDocument } from "../../src/core/documents";
import { seedAccounts, verifyAuditChain } from "../../src/core/ledger";
import { buildVatReport, postEuServiceReverseChargePurchase } from "../../src/core/vat";
import { storeViesValidation } from "../../src/core/vies";

describe("EU service reverse-charge VAT", () => {
  test("requires cached VIES validation before posting reverse-charge purchase", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-rc-missing-vies-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-rc-missing-vies-inbox-"));
    const sourceFile = join(inbox, "eu-service.txt");
    writeFileSync(sourceFile, "EU service invoice\n1000 DKK\n");

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const doc = ingestDocument(db, root, sourceFile, {
      source: "email",
      issueDate: "2026-05-16",
      invoiceNo: "EU-INV-1",
      deliveryDescription: "EU software service",
      amountIncVat: 1000,
      currency: "DKK",
      sender: { name: "EU Supplier GmbH", address: "Berlin", vatOrCvr: "DE123456789" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 0,
      paymentDetails: "Bank transfer"
    });
    expect(doc.ok).toBe(true);

    const missing = postEuServiceReverseChargePurchase(db, {
      transactionDate: "2026-05-16",
      text: "EU service purchase",
      documentId: doc.documentId!,
      netAmount: 1000,
      expenseAccountNo: "3010"
    });
    expect(missing.ok).toBe(false);
    expect(missing.errors[0]).toContain("VIES lookup not yet performed");

    storeViesValidation(db, {
      vatOrCvr: "DE123456789",
      valid: true,
      validatedAt: "2026-05-15T00:00:00.000Z",
      expiresAt: "2026-08-15T00:00:00.000Z",
      rawResponse: JSON.stringify({ valid: true })
    });

    const posted = postEuServiceReverseChargePurchase(db, {
      transactionDate: "2026-05-16",
      text: "EU service purchase",
      documentId: doc.documentId!,
      netAmount: 1000,
      expenseAccountNo: "3010"
    });

    expect(posted.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  });

  test("posts a compliant reverse-charge purchase and reports equal output/input VAT", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-rc-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-rc-inbox-"));
    const sourceFile = join(inbox, "eu-service.txt");
    writeFileSync(sourceFile, "EU service invoice\n1000 DKK\n");

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const doc = ingestDocument(db, root, sourceFile, {
      source: "email",
      issueDate: "2026-05-16",
      invoiceNo: "EU-INV-1",
      deliveryDescription: "EU software service",
      amountIncVat: 1000,
      currency: "DKK",
      sender: { name: "EU Supplier GmbH", address: "Berlin", vatOrCvr: "DE123456789" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 0,
      paymentDetails: "Bank transfer"
    });
    expect(doc.ok).toBe(true);

    storeViesValidation(db, {
      vatOrCvr: "DE123456789",
      valid: true,
      validatedAt: "2026-05-15T00:00:00.000Z",
      expiresAt: "2026-08-15T00:00:00.000Z",
      rawResponse: JSON.stringify({ valid: true })
    });

    const posted = postEuServiceReverseChargePurchase(db, {
      transactionDate: "2026-05-16",
      text: "EU service purchase",
      documentId: doc.documentId!,
      netAmount: 1000,
      expenseAccountNo: "3010"
    });

    expect(posted.ok).toBe(true);
    expect(posted.appliedRules).toContain("DK-VAT-REVERSE-CHARGE-001");

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(posted.entryId!) as any[];
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ account_no: "3010", debit_amount: 1000, vat_code: "EU_SERVICE_REVERSE_CHARGE" });
    expect(lines[1]).toMatchObject({ account_no: "4000", debit_amount: 250 });
    expect(lines[3]).toMatchObject({ account_no: "1200", credit_amount: 250 });

    const vat = buildVatReport(db, "2026-05-01", "2026-05-31");
    expect(vat.ok).toBe(true);
    expect(vat.outputVat).toBe(250);
    expect(vat.inputVat).toBe(250);
    expect(vat.reverseChargePurchaseBase).toBe(1000);
    expect(vat.netVatPayable).toBe(0);

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  });
});
