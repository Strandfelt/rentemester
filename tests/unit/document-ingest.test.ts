import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { ingestDocument, validateDocumentMetadata } from "../../src/core/documents";

describe("document ingest", () => {
  test("rejects purchase/sale document metadata missing statutory fields", () => {
    const result = validateDocumentMetadata({
      source: "email",
      issueDate: "2026-05-16",
      amountIncVat: 1250,
      currency: "DKK",
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("deliveryDescription is required");
    expect(result.errors).toContain("paymentDetails is required");
  });

  test("ingests a compliant supporting document and stores it content-addressed", () => {
    const companyRoot = mkdtempSync(join(tmpdir(), "rentemester-company-"));
    const inboxRoot = mkdtempSync(join(tmpdir(), "rentemester-inbox-"));
    const sourceFile = join(inboxRoot, "vendor-invoice.txt");
    writeFileSync(sourceFile, "Invoice 1001\nAmount 1250 DKK\n");

    const paths = ensureCompanyDirs(companyRoot);
    const db = openDb(paths.db);
    migrate(db);

    const result = ingestDocument(db, companyRoot, sourceFile, {
      source: "email",
      issueDate: "2026-05-16",
      invoiceNo: "INV-1001",
      deliveryDescription: "Bogføring og momsafstemning",
      amountIncVat: 1250,
      currency: "DKK",
      sender: { name: "Leverandør ApS", address: "Sælgervej 1, 2100 København Ø", vatOrCvr: "DK11223344" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1, 2100 København Ø", vatOrCvr: "DK12345678" },
      vatAmount: 250,
      paymentDetails: "Betalt via bankoverførsel 2026-05-17"
    });

    expect(result.ok).toBe(true);
    expect(result.documentNo).toBeDefined();
    expect(existsSync(result.storedPath!)).toBe(true);

    const row = db.query("SELECT document_no, source, invoice_no, amount_inc_vat, vat_amount, payment_details FROM documents WHERE id = ?").get(result.documentId!) as any;
    expect(row.document_no).toBe(result.documentNo);
    expect(row.invoice_no).toBe("INV-1001");
    expect(row.amount_inc_vat).toBe(1250);
    expect(row.vat_amount).toBe(250);
    expect(row.payment_details).toContain("bankoverførsel");

    const dup = ingestDocument(db, companyRoot, sourceFile, {
      source: "email",
      issueDate: "2026-05-16",
      deliveryDescription: "Bogføring og momsafstemning",
      amountIncVat: 1250,
      currency: "DKK",
      sender: { name: "Leverandør ApS", address: "Sælgervej 1, 2100 København Ø", vatOrCvr: "DK11223344" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1, 2100 København Ø", vatOrCvr: "DK12345678" },
      vatAmount: 250,
      paymentDetails: "Betalt via bankoverførsel 2026-05-17"
    });
    expect(dup.ok).toBe(false);
    expect(dup.errors?.[0]).toContain("duplicate document content already ingested");

    db.close();
    rmSync(companyRoot, { recursive: true, force: true });
    rmSync(inboxRoot, { recursive: true, force: true });
  });
});
