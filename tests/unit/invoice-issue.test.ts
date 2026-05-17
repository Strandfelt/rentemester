import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs, companyPaths } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
import { issueCreditNote } from "../../src/core/credit-notes";

function failingDocumentInsertDb(realDb: any) {
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return (sql: string) => {
          const statement = target.query(sql);
          if (sql.includes("INSERT INTO documents")) {
            return { get() { throw new Error("simulated insert failure"); } };
          }
          return statement;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as any;
}

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

  test("does not leave an orphan invoice file when document insert fails", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-issue-fail-"));
    const realDb = openDb(ensureCompanyDirs(root).db);
    migrate(realDb);
    const failingDb = failingDocumentInsertDb(realDb);

    expect(() => issueInvoice(failingDb, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0501",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    })).toThrow("simulated insert failure");

    expect(readdirSync(companyPaths(root).invoicesIssued)).toEqual([]);

    realDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("does not leave an orphan credit-note file when document insert fails", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-credit-fail-"));
    const realDb = openDb(ensureCompanyDirs(root).db);
    migrate(realDb);

    const issued = issueInvoice(realDb, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0502",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);

    const failingDb = failingDocumentInsertDb(realDb);
    const result = issueCreditNote(failingDb, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-17",
      creditNoteNumber: "CN-2026-0001",
      reason: "Test rollback",
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("simulated insert failure");
    expect(readdirSync(companyPaths(root).invoicesIssued)).toEqual(["2026-0502.json"]);

    realDb.close();
    rmSync(root, { recursive: true, force: true });
  });
});
