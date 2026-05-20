import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
import { exportPublicEInvoiceOioUbl, exportPublicEInvoicePreview } from "../../src/core/public-einvoice";

describe("public e-invoice preview export", () => {
  test("exports a deterministic preview artifact for public-recipient invoices", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-public-einvoice-"));
    const outPath = join(root, "public-invoice.xml");
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-20",
      invoiceNumber: "2026-0700",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: {
        name: "Københavns Kommune",
        address: "Rådhuset, 1599 København V",
        publicRecipient: true,
        eanNumber: "5790000000001",
      },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1500, lineTotalExVat: 1500 }],
      totals: { netAmount: 1500, vatRate: 0.25, vatAmount: 375, grossAmount: 1875 },
      currency: "DKK",
      dueDate: "2026-06-19",
    });

    expect(issued.ok).toBe(true);
    const first = exportPublicEInvoicePreview(db, { invoiceDocumentId: issued.documentId!, outPath });
    const second = exportPublicEInvoicePreview(db, { invoiceDocumentId: issued.documentId! });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.sha256).toBe(second.sha256);
    expect(first.xml).toBe(second.xml);
    expect(readFileSync(outPath, "utf8")).toBe(first.xml);
    expect(first.xml).toContain("<EanNumber>5790000000001</EanNumber>");
    expect(first.xml).toContain("<Transport>out_of_scope_peppol_access_point_required</Transport>");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects export for invoices that are not marked as public-recipient invoices", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-public-einvoice-nonpublic-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-20",
      invoiceNumber: "2026-0701",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Privat Kunde", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1500, lineTotalExVat: 1500 }],
      totals: { netAmount: 1500, vatRate: 0.25, vatAmount: 375, grossAmount: 1875 },
      currency: "DKK",
    });

    expect(issued.ok).toBe(true);
    const exported = exportPublicEInvoicePreview(db, { invoiceDocumentId: issued.documentId! });

    expect(exported.ok).toBe(false);
    expect(exported.errors).toContain("invoice 2026-0701 is not marked as a public-recipient e-invoice");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("exports a deterministic OIOUBL handoff artifact and records audit metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-public-oioubl-"));
    const outPath = join(root, "public-invoice-oioubl.xml");
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-20",
      invoiceNumber: "2026-0702",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: {
        name: "Københavns Kommune",
        address: "Rådhuset, 1599 København V",
        publicRecipient: true,
        eanNumber: "5790000000001",
      },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1500, lineTotalExVat: 1500 }],
      totals: { netAmount: 1500, vatRate: 0.25, vatAmount: 375, grossAmount: 1875 },
      currency: "DKK",
      dueDate: "2026-06-19",
    });

    expect(issued.ok).toBe(true);

    const first = exportPublicEInvoiceOioUbl(db, { invoiceDocumentId: issued.documentId!, outPath });
    const second = exportPublicEInvoiceOioUbl(db, { invoiceDocumentId: issued.documentId! });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.sha256).toBe(second.sha256);
    expect(first.xml).toBe(second.xml);
    expect(readFileSync(outPath, "utf8")).toBe(first.xml);
    expect(first.xml).toContain("<cbc:CustomizationID>urn:fdc:oioubl.dk:trns:billing:invoice:3.0</cbc:CustomizationID>");
    expect(first.xml).toContain("<cbc:ProfileID>urn:fdc:oioubl.dk:bis:billing_with_response:3</cbc:ProfileID>");
    expect(first.xml).toContain('<cbc:EndpointID schemeID="0188">5790000000001</cbc:EndpointID>');

    const auditRows = db.query(
      "SELECT event_type, entity_type, entity_id, message FROM audit_log WHERE event_type = 'public_einvoice_oioubl_export' ORDER BY id ASC",
    ).all() as Array<{ event_type: string; entity_type: string; entity_id: string; message: string }>;

    expect(auditRows).toHaveLength(2);
    expect(auditRows[0]).toEqual({
      event_type: "public_einvoice_oioubl_export",
      entity_type: "document",
      entity_id: String(issued.documentId),
      message: `Generated public OIOUBL handoff artifact for invoice 2026-0702 (sha256 ${first.sha256})`,
    });

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects OIOUBL export when required public-recipient handoff metadata is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-public-oioubl-missing-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-20",
      invoiceNumber: "2026-0703",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: {
        name: "Københavns Kommune",
        address: "Rådhuset, 1599 København V",
        publicRecipient: true,
        eanNumber: "5790000000001",
      },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1500, lineTotalExVat: 1500 }],
      totals: { netAmount: 1500, vatRate: 0.25, vatAmount: 375, grossAmount: 1875 },
      currency: "DKK",
    });

    expect(issued.ok).toBe(true);

    const exported = exportPublicEInvoiceOioUbl(db, { invoiceDocumentId: issued.documentId! });

    expect(exported.ok).toBe(false);
    expect(exported.errors).toContain("invoice 2026-0703 is missing dueDate required for OIOUBL handoff");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
