import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
import { postIssuedInvoiceToLedger } from "../../src/core/invoice-booking";
import { ingestDocument } from "../../src/core/documents";
import { postJournalEntry, seedAccounts } from "../../src/core/ledger";
import { exportAuthorityPackage } from "../../src/core/authority-export";

describe("authority export", () => {
  test("exports a machine-readable period package with readable supporting documents", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-authority-export-"));
    const companyRoot = join(root, "company");
    const exportRoot = join(root, "exports");
    const paths = ensureCompanyDirs(companyRoot);
    const db = openDb(paths.db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, companyRoot, JSON.parse(readFileSync(join(process.cwd(), "examples/full-invoice.dk.json"), "utf8")));
    expect(issued.ok).toBe(true);
    const posted = postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(posted.ok).toBe(true);

    const ingested = ingestDocument(db, companyRoot, join(process.cwd(), "examples/vendor-invoice.txt"), JSON.parse(readFileSync(join(process.cwd(), "examples/vendor-invoice.metadata.json"), "utf8")));
    expect(ingested.ok).toBe(true);
    const expense = postJournalEntry(db, JSON.parse(readFileSync(join(process.cwd(), "examples/journal-entry.expense.json"), "utf8")));
    expect(expense.ok).toBe(true);

    const result = exportAuthorityPackage(db, companyRoot, {
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
      outputDir: exportRoot,
      requestedAt: "2026-05-17T02:24:00.000Z",
      requester: "Skattestyrelsen",
    });

    expect(result.ok).toBe(true);
    expect(result.deadlineAt).toBe("2026-06-14T02:24:00.000Z");
    expect(existsSync(result.manifestPath!)).toBe(true);

    const manifest = JSON.parse(readFileSync(result.manifestPath!, "utf8"));
    expect(manifest.counts.journalEntries).toBe(2);
    expect(manifest.counts.documents).toBe(2);
    expect(manifest.counts.copiedReadableDocuments).toBe(2);

    const exportedDocs = JSON.parse(readFileSync(join(result.exportDir!, "machine-readable", "documents.json"), "utf8"));
    expect(exportedDocs).toHaveLength(2);
    expect(exportedDocs.some((doc: any) => doc.documentType === "issued_invoice")).toBe(true);
    expect(exportedDocs.some((doc: any) => doc.documentType === "purchase_sale")).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
