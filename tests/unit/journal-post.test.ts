import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { ingestDocument } from "../../src/core/documents";
import { postJournalEntry, seedAccounts, verifyAuditChain } from "../../src/core/ledger";

describe("journal posting", () => {
  test("rejects unbalanced journal entries", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journal-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const result = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Broken posting",
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 900 }
      ]
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("journal entry must balance: debit 1000 != credit 900");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("requires document evidence for expense or income postings and hashes lines into the audit chain", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journal-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-inbox-"));
    const sourceFile = join(inbox, "vendor.txt");
    writeFileSync(sourceFile, "Vendor invoice\n1250 DKK\n");

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const missingDoc = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Software expense without evidence",
      lines: [
        { accountNo: "3000", debitAmount: 1000 },
        { accountNo: "4000", debitAmount: 250 },
        { accountNo: "2000", creditAmount: 1250 }
      ]
    });
    expect(missingDoc.ok).toBe(false);
    expect(missingDoc.errors).toContain("documentId is required when posting expense or income lines");

    const doc = ingestDocument(db, root, sourceFile, {
      source: "email",
      issueDate: "2026-05-16",
      invoiceNo: "INV-3000",
      deliveryDescription: "Softwareabonnement",
      amountIncVat: 1250,
      currency: "DKK",
      sender: { name: "Leverandør ApS", address: "Sælgervej 1", vatOrCvr: "DK11223344" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 250,
      paymentDetails: "Bankoverførsel"
    });
    expect(doc.ok).toBe(true);

    const posted = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Software expense with evidence",
      documentId: doc.documentId,
      lines: [
        { accountNo: "3000", debitAmount: 1000, vatCode: "DK_PURCHASE_25" },
        { accountNo: "4000", debitAmount: 250 },
        { accountNo: "2000", creditAmount: 1250, text: "Bank payment" }
      ]
    });

    expect(posted.ok).toBe(true);
    expect(posted.entryNo).toBeDefined();
    expect(posted.appliedRules).toContain("DK-BOOKKEEPING-DOCUMENT-001");

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(true);
    expect(chain.entries).toBe(1);

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code, jl.text
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(posted.entryId!) as any[];
    expect(lines).toHaveLength(3);
    expect(lines[0].vat_code).toBe("DK_PURCHASE_25");

    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  });
});
