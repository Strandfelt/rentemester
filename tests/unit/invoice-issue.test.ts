import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";

describe("invoice issue", () => {
  test("issues a validated invoice as immutable persisted snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-issue-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const result = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0500",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });

    expect(result.ok).toBe(true);
    expect(result.invoiceNumber).toBe("2026-0500");
    expect(result.appliedRules).toContain("DK-INVOICE-ISSUE-001");
    expect(existsSync(result.storedPath!)).toBe(true);

    const stored = JSON.parse(readFileSync(result.storedPath!, "utf8"));
    expect(stored.status).toBe("issued");
    expect(stored.issuedAt).toBeTruthy();
    expect(stored.invoiceNumber).toBe("2026-0500");

    const row = db.query("SELECT document_type, invoice_no, status, payload_json FROM documents WHERE id = ?").get(result.documentId!) as any;
    expect(row.document_type).toBe("issued_invoice");
    expect(row.invoice_no).toBe("2026-0500");
    expect(row.status).toBe("issued");
    expect(JSON.parse(row.payload_json).invoiceNumber).toBe("2026-0500");

    expect(() => db.run("UPDATE documents SET status = 'changed' WHERE id = ?", result.documentId!)).toThrow();

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
