// Tests: src/core/saft-export.ts
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
import { postIssuedInvoiceToLedger } from "../../src/core/invoice-booking";
import { seedAccounts } from "../../src/core/ledger";
import { exportSaftPackage } from "../../src/core/saft-export";

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("SAF-T export", () => {
  test("exports a deterministic first-slice SAF-T package with ledger and sales invoices", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-saft-export-"));
    const companyRoot = join(root, "company");
    const exportRoot = join(root, "exports");
    const paths = ensureCompanyDirs(companyRoot);
    const db = openDb(paths.db);
    migrate(db);
    seedAccounts(db);
    db.run("INSERT INTO companies (id, name, country, currency, cvr, fiscal_year_start_month, fiscal_year_label_strategy) VALUES (1, 'Rentemester ApS', 'DK', 'DKK', 'DK12345678', 1, 'end-year')");

    const issued = issueInvoice(db, companyRoot, JSON.parse(readFileSync(join(process.cwd(), "examples/full-invoice.dk.json"), "utf8")));
    expect(issued.ok).toBe(true);
    const posted = postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(posted.ok).toBe(true);

    const first = exportSaftPackage(db, companyRoot, {
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
      outputDir: exportRoot,
      generatedAt: "2026-05-17T02:24:00.000Z",
    });

    expect(first.ok).toBe(true);
    expect(existsSync(first.manifestPath!)).toBe(true);
    expect(existsSync(first.saftXmlPath!)).toBe(true);

    const second = exportSaftPackage(db, companyRoot, {
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
      outputDir: exportRoot,
      generatedAt: "2026-05-17T02:24:00.000Z",
    });

    expect(second.ok).toBe(true);
    expect(second.exportDir).toBe(first.exportDir);
    expect(sha256(first.manifestPath!)).toBe(sha256(second.manifestPath!));
    expect(sha256(first.saftXmlPath!)).toBe(sha256(second.saftXmlPath!));

    const manifest = JSON.parse(readFileSync(first.manifestPath!, "utf8"));
    expect(manifest.packageType).toBe("saft_export");
    expect(manifest.profileId).toBe("rentemester-dk-saft-v1-ledger-sales");
    expect(manifest.counts.journalEntries).toBe(1);
    expect(manifest.counts.salesInvoices).toBe(1);
    expect(manifest.files.saftXml).toBe("saft.xml");
    expect(manifest.outOfScope).toContain("purchase_documents");
    expect(manifest.outOfScope).toContain("bank_statement_transport");

    const xml = readFileSync(first.saftXmlPath!, "utf8");
    expect(xml).toContain("<AuditFile");
    expect(xml).toContain("<ProfileID>rentemester-dk-saft-v1-ledger-sales</ProfileID>");
    expect(xml).toContain("<RegistrationNumber>DK12345678</RegistrationNumber>");
    expect(xml).toContain("<AccountID>1000</AccountID>");
    expect(xml).toContain("<TransactionID>2026-00001</TransactionID>");
    expect(xml).toContain("<InvoiceNo>2026-0001</InvoiceNo>");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("fails clearly when required SAF-T source fields are missing", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-saft-export-missing-"));
    const companyRoot = join(root, "company");
    const exportRoot = join(root, "exports");
    const paths = ensureCompanyDirs(companyRoot);
    const db = openDb(paths.db);
    migrate(db);
    seedAccounts(db);
    db.run("INSERT INTO companies (id, name, country, currency) VALUES (1, 'Rentemester ApS', 'DK', 'DKK')");

    const result = exportSaftPackage(db, companyRoot, {
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
      outputDir: exportRoot,
      generatedAt: "2026-05-17T02:24:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("company cvr is required for SAF-T export");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
