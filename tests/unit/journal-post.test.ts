import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { ingestDocument } from "../../src/core/documents";
import { postJournalEntry, reverseJournalEntry, seedAccounts, verifyAuditChain } from "../../src/core/ledger";
import { issueInvoice } from "../../src/core/issued-invoices";
import { postIssuedInvoiceToLedger } from "../../src/core/invoice-booking";
import { closeAccountingPeriod } from "../../src/core/periods";

function failingJournalInsertDb(realDb: any) {
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return (sql: string) => {
          const statement = target.query(sql);
          if (sql.includes("INSERT INTO journal_entries")) {
            return { get() { throw new Error("simulated journal insert failure"); } };
          }
          return statement;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as any;
}

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

  test("rejects journal lines with negative debit or credit amounts", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journal-negative-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const result = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Negative-amount posting",
      lines: [
        { accountNo: "2000", debitAmount: -500 },
        { accountNo: "5000", creditAmount: -500 }
      ]
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("must not be negative"))).toBe(true);

    const positive = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Valid positive posting",
      lines: [
        { accountNo: "2000", debitAmount: 500 },
        { accountNo: "5000", creditAmount: 500 }
      ]
    });
    expect(positive.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("numbers journal entries from transaction year and resets per year", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journal-entryno-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const first2024 = postJournalEntry(db, {
      transactionDate: "2024-12-31",
      text: "Year-end entry",
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    });
    const second2024 = postJournalEntry(db, {
      transactionDate: "2024-01-01",
      text: "Opening correction",
      lines: [
        { accountNo: "2000", debitAmount: 500 },
        { accountNo: "5000", creditAmount: 500 }
      ]
    });
    const first2025 = postJournalEntry(db, {
      transactionDate: "2025-01-01",
      text: "New year entry",
      lines: [
        { accountNo: "2000", debitAmount: 750 },
        { accountNo: "5000", creditAmount: 750 }
      ]
    });

    expect(first2024.entryNo).toBe("2024-00001");
    expect(second2024.entryNo).toBe("2024-00002");
    expect(first2025.entryNo).toBe("2025-00001");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("uses configured fiscal year labels for journal entry numbers", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journal-fiscal-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);
    db.run(
      `INSERT INTO companies (id, name, cvr, fiscal_year_start_month, fiscal_year_label_strategy)
       VALUES (1, 'Rentemester ApS', 'DK12345678', 7, 'end-year')`
    );

    const first = postJournalEntry(db, {
      transactionDate: "2024-07-01",
      text: "Opening fiscal entry",
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    });
    const second = postJournalEntry(db, {
      transactionDate: "2025-06-30",
      text: "Fiscal year close",
      lines: [
        { accountNo: "2000", debitAmount: 500 },
        { accountNo: "5000", creditAmount: 500 }
      ]
    });
    const next = postJournalEntry(db, {
      transactionDate: "2025-07-01",
      text: "Next fiscal year",
      lines: [
        { accountNo: "2000", debitAmount: 750 },
        { accountNo: "5000", creditAmount: 750 }
      ]
    });

    expect(first.entryNo).toBe("2025-00001");
    expect(second.entryNo).toBe("2025-00002");
    expect(next.entryNo).toBe("2026-00001");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("respects the highest existing journal number when a stale sequence row lags behind", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journal-stale-seq-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const bank = db.query("SELECT id FROM accounts WHERE account_no = '2000'").get() as { id: number };
    const equity = db.query("SELECT id FROM accounts WHERE account_no = '5000'").get() as { id: number };
    db.run(
      `INSERT INTO journal_entries (
        id, entry_no, transaction_date, text, rule_version, created_by, created_by_program, status, previous_hash, entry_hash, retain_until
      ) VALUES (1, '2026-00005', '2026-05-15', 'Legacy imported entry', 'legacy-import', 'legacy', 'restore', 'posted', 'GENESIS', 'legacy-hash', '2031-12-31')`
    );
    db.run(`INSERT INTO journal_lines (journal_entry_id, account_id, debit_amount, credit_amount, currency, text) VALUES (1, ?, 1000, 0, 'DKK', 'legacy debit')`, bank.id);
    db.run(`INSERT INTO journal_lines (journal_entry_id, account_id, debit_amount, credit_amount, currency, text) VALUES (1, ?, 0, 1000, 'DKK', 'legacy credit')`, equity.id);
    db.run(`INSERT INTO sequences (kind, scope, value) VALUES ('journal_entry', 'company-1:2026', 1)`);

    const posted = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Entry after stale restore sequence",
      lines: [
        { accountNo: "2000", debitAmount: 500 },
        { accountNo: "5000", creditAmount: 500 }
      ]
    });

    expect(posted.ok).toBe(true);
    expect(posted.entryNo).toBe("2026-00006");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("does not burn a journal number when insert fails after allocation", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journal-rollback-seq-"));
    const realDb = openDb(ensureCompanyDirs(root).db);
    migrate(realDb);
    seedAccounts(realDb);
    const failingDb = failingJournalInsertDb(realDb);

    expect(() => postJournalEntry(failingDb, {
      transactionDate: "2026-05-16",
      text: "Should roll back sequence",
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    })).toThrow("simulated journal insert failure");

    const sequence = realDb.query("SELECT value FROM sequences WHERE kind = 'journal_entry' AND scope = 'company-1:2026'").get() as { value: number } | null;
    expect(sequence).toBeNull();

    const posted = postJournalEntry(realDb, {
      transactionDate: "2026-05-16",
      text: "First surviving entry",
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    });
    expect(posted.ok).toBe(true);
    expect(posted.entryNo).toBe("2026-00001");

    realDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("uses immediate transactions for journal writes and reversals", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journal-immediate-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const seenOptions: any[] = [];
    const instrumentedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return (fn: (...args: any[]) => any, options?: any) => {
            seenOptions.push(options ?? null);
            return target.transaction(fn, options);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as any;

    const posted = postJournalEntry(instrumentedDb, {
      transactionDate: "2026-05-16",
      text: "Immediate transaction proof",
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    });
    expect(posted.ok).toBe(true);

    const reversed = reverseJournalEntry(instrumentedDb, {
      entryId: posted.entryId!,
      transactionDate: "2026-05-17",
      reason: "Proof"
    });
    expect(reversed.ok).toBe(true);
    expect(seenOptions.filter((options) => options?.immediate === true)).toHaveLength(2);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("supports foreign-currency journal entries with stored FX basis", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journal-fx-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-inbox-fx-"));
    const sourceFile = join(inbox, "vendor-eur.txt");
    writeFileSync(sourceFile, "Vendor invoice\n100 EUR\n");

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const doc = ingestDocument(db, root, sourceFile, {
      source: "email",
      issueDate: "2026-05-19",
      invoiceNo: "INV-EUR-1",
      deliveryDescription: "Softwareabonnement EUR",
      amountIncVat: 746,
      currency: "DKK",
      sender: { name: "Leverandør GmbH", address: "Berlin", vatOrCvr: "DE123456789" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 149.2,
      paymentDetails: "Kortbetaling"
    });
    expect(doc.ok).toBe(true);

    const badFx = postJournalEntry(db, {
      transactionDate: "2026-05-19",
      text: "FX journal without conversion basis",
      documentId: doc.documentId,
      currency: "EUR",
      lines: [
        { accountNo: "3000", debitAmount: 596.8, vatCode: "DK_PURCHASE_25" },
        { accountNo: "4000", debitAmount: 149.2 },
        { accountNo: "2000", creditAmount: 746 }
      ]
    });
    expect(badFx.ok).toBe(false);
    expect(badFx.errors).toContain("amountForeign must be positive for non-DKK journal entries");

    const posted = postJournalEntry(db, {
      transactionDate: "2026-05-19",
      text: "FX journal with conversion basis",
      documentId: doc.documentId,
      currency: "EUR",
      amountForeign: 100,
      amountDkk: 746,
      fxRateToDkk: 7.46,
      lines: [
        { accountNo: "3000", debitAmount: 596.8, vatCode: "DK_PURCHASE_25" },
        { accountNo: "4000", debitAmount: 149.2 },
        { accountNo: "2000", creditAmount: 746 }
      ]
    });

    expect(posted.ok).toBe(true);
    expect(posted.appliedRules).toContain("DK-BOOKKEEPING-FX-001");
    const entry = db.query("SELECT currency, amount_foreign, amount_dkk, fx_rate_to_dkk FROM journal_entries WHERE id = ?").get(posted.entryId!) as any;
    expect(entry).toEqual({ currency: "EUR", amount_foreign: 100, amount_dkk: 746, fx_rate_to_dkk: 7.46 });

    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  });

  test("normalizes FX payloads before persistence so audit verification reads the same rounded values", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journal-fx-normalized-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-journal-fx-normalized-inbox-"));
    const sourceFile = join(inbox, "invoice.txt");
    writeFileSync(sourceFile, "Invoice\n745.56 DKK\n");

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const doc = ingestDocument(db, root, sourceFile, {
      source: "email",
      issueDate: "2026-05-19",
      invoiceNo: "INV-EUR-2",
      deliveryDescription: "Softwareabonnement EUR",
      amountIncVat: 745.56,
      currency: "DKK",
      sender: { name: "Leverandør GmbH", address: "Berlin", vatOrCvr: "DE123456789" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 149.11,
      paymentDetails: "Kortbetaling"
    });
    expect(doc.ok).toBe(true);

    const posted = postJournalEntry(db, {
      transactionDate: "2026-05-19",
      text: "FX journal with normalized conversion basis",
      documentId: doc.documentId,
      currency: "EUR",
      amountForeign: 100,
      amountDkk: 745.56,
      fxRateToDkk: 7.4555555,
      lines: [
        { accountNo: "3000", debitAmount: 596.45, vatCode: "DK_PURCHASE_25" },
        { accountNo: "4000", debitAmount: 149.11 },
        { accountNo: "2000", creditAmount: 745.56 }
      ]
    });

    expect(posted.ok).toBe(true);
    const entry = db.query("SELECT amount_foreign, amount_dkk, fx_rate_to_dkk FROM journal_entries WHERE id = ?").get(posted.entryId!) as any;
    expect(entry).toEqual({ amount_foreign: 100, amount_dkk: 745.56, fx_rate_to_dkk: 7.455556 });
    expect(verifyAuditChain(db).ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  });

  test("records actor attribution from environment for direct journal posts", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journal-actor-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const prevActor = process.env.RENTEMESTER_ACTOR;
    const prevVia = process.env.RENTEMESTER_ACTOR_VIA;
    process.env.RENTEMESTER_ACTOR = "agent:freja";
    process.env.RENTEMESTER_ACTOR_VIA = "openclaw";

    try {
      const posted = postJournalEntry(db, {
        transactionDate: "2026-05-16",
        text: "Owner contribution",
        lines: [
          { accountNo: "2000", debitAmount: 1000 },
          { accountNo: "5000", creditAmount: 1000 }
        ]
      });

      expect(posted.ok).toBe(true);
      const entry = db.query("SELECT created_by, created_by_program FROM journal_entries WHERE id = ?").get(posted.entryId!) as any;
      expect(entry).toEqual({ created_by: "agent:freja", created_by_program: "openclaw" });
      const audit = db.query("SELECT actor FROM audit_log WHERE event_type = 'journal_post' ORDER BY id DESC LIMIT 1").get() as any;
      expect(audit.actor).toBe("agent:freja via openclaw");
    } finally {
      if (prevActor === undefined) delete process.env.RENTEMESTER_ACTOR; else process.env.RENTEMESTER_ACTOR = prevActor;
      if (prevVia === undefined) delete process.env.RENTEMESTER_ACTOR_VIA; else process.env.RENTEMESTER_ACTOR_VIA = prevVia;
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks closed-period and future-dated journal postings while allowing correcting entries in an open period", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journal-period-lock-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const closed = closeAccountingPeriod(db, {
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
      kind: "vat_quarter",
      reference: "SKAT-Q2-2026"
    });
    expect(closed.ok).toBe(true);

    const insideClosed = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Late backpost into closed period",
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    });
    expect(insideClosed.ok).toBe(false);
    expect(insideClosed.errors).toContain("transactionDate 2026-05-16 falls in closed period vat_quarter 2026-05-01..2026-05-31 ref SKAT-Q2-2026");

    const futureDated = postJournalEntry(db, {
      transactionDate: "2099-12-31",
      text: "Future-dated hiding entry",
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    });
    expect(futureDated.ok).toBe(false);
    expect(futureDated.errors.some((error) => error.includes("transactionDate 2099-12-31 cannot be later than"))).toBe(true);

    const correction = postJournalEntry(db, {
      transactionDate: "2026-06-01",
      text: "Correction posted in next open period",
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    });
    expect(correction.ok).toBe(true);

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

describe("ledger hardening", () => {
  test("prevents direct mutation of journal lines after posting", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-ledger-lines-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const posted = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Owner contribution",
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    });
    expect(posted.ok).toBe(true);

    expect(() => db.run("UPDATE journal_lines SET debit_amount = 999 WHERE journal_entry_id = ?", posted.entryId!)).toThrow("journal_lines are append-only");
    expect(() => db.run("DELETE FROM journal_lines WHERE journal_entry_id = ?", posted.entryId!)).toThrow("journal_lines are append-only");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("prevents mutation or deletion of purchase documents once linked to a journal entry", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-linked-doc-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-linked-doc-inbox-"));
    const sourceFile = join(inbox, "vendor.txt");
    writeFileSync(sourceFile, "Vendor invoice\n1250 DKK\n");

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const doc = ingestDocument(db, root, sourceFile, {
      source: "email",
      issueDate: "2026-05-16",
      invoiceNo: "INV-LINKED",
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
        { accountNo: "2000", creditAmount: 1250 }
      ]
    });
    expect(posted.ok).toBe(true);

    expect(() => db.run("UPDATE documents SET amount_inc_vat = 999 WHERE id = ?", doc.documentId!)).toThrow("document is linked to a journal entry");
    expect(() => db.run("DELETE FROM documents WHERE id = ?", doc.documentId!)).toThrow("document is linked to a journal entry");

    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  });

  test("enforces one posted journal entry per source bank transaction at database level", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-unique-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const bank = db.query(
      `INSERT INTO bank_transactions (transaction_date, text, amount, transaction_hash)
       VALUES ('2026-05-16', 'Customer payment', 1000, 'unique-bank-source-test')
       RETURNING id`
    ).get() as { id: number };

    const first = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Bank-linked posting",
      sourceBankTransactionId: bank.id,
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    });
    expect(first.ok).toBe(true);

    expect(() => postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Duplicate bank-linked posting",
      sourceBankTransactionId: bank.id,
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    })).toThrow("UNIQUE constraint failed");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("prevents mutation or deletion of referenced bank transactions", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-append-only-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const bank = db.query(
      `INSERT INTO bank_transactions (transaction_date, text, amount, transaction_hash)
       VALUES ('2026-05-16', 'Customer payment', 1000, 'bank-append-only-test')
       RETURNING id`
    ).get() as { id: number };

    const posted = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Bank-linked posting",
      sourceBankTransactionId: bank.id,
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    });
    expect(posted.ok).toBe(true);

    expect(() => db.run("UPDATE bank_transactions SET amount = 9999 WHERE id = ?", bank.id)).toThrow("bank transaction is referenced by ledger or payment records and cannot be modified");
    expect(() => db.run("DELETE FROM bank_transactions WHERE id = ?", bank.id)).toThrow("bank transactions are append-only");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("protects compliance tables against destructive rewrites", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-compliance-append-only-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);
    db.run(`INSERT INTO companies (id, name, cvr, fiscal_year_start_month, fiscal_year_label_strategy) VALUES (1, 'Rentemester ApS', 'DK12345678', 1, 'end-year')`);

    const posted = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Compliance hardening proof",
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    });
    expect(posted.ok).toBe(true);

    const audit = db.query("SELECT id FROM audit_log WHERE event_type = 'journal_post' ORDER BY id DESC LIMIT 1").get() as { id: number };
    expect(() => db.run("UPDATE audit_log SET actor = 'spoof@example.com' WHERE id = ?", audit.id)).toThrow("audit_log is append-only");
    expect(() => db.run("DELETE FROM audit_log WHERE id = ?", audit.id)).toThrow("audit_log is append-only");

    const period = closeAccountingPeriod(db, {
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
      kind: "custom",
      status: "closed"
    });
    expect(period.ok).toBe(true);
    expect(() => db.run("UPDATE accounting_periods SET status = 'open' WHERE id = ?", period.periodId!)).toThrow("accounting periods may only progress open -> closed -> reported; period bounds are immutable");
    expect(() => db.run("DELETE FROM accounting_periods WHERE id = ?", period.periodId!)).toThrow("accounting periods are append-only");

    expect(() => db.run("UPDATE sequences SET value = value - 1 WHERE kind = 'journal_entry'")).toThrow("sequences are immutable identifiers and monotonically increasing");
    expect(() => db.run("DELETE FROM sequences WHERE kind = 'journal_entry'")).toThrow("sequences are append-only");

    const exception = db.query(
      `INSERT INTO exceptions (type, severity, status, message, required_action)
       VALUES ('UNMATCHED_BANK_TRANSACTION', 'high', 'open', 'Needs review', 'Match to document')
       RETURNING id`
    ).get() as { id: number };
    db.run("UPDATE exceptions SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolved_by = 'tester', resolution_note = 'done' WHERE id = ?", exception.id);
    expect(() => db.run("UPDATE exceptions SET status = 'open' WHERE id = ?", exception.id)).toThrow("exceptions may only progress from open to resolved; identity is immutable");
    expect(() => db.run("DELETE FROM exceptions WHERE id = ?", exception.id)).toThrow("exceptions are append-only; resolve them instead");

    expect(() => db.run("UPDATE companies SET fiscal_year_start_month = 7 WHERE id = 1")).toThrow("fiscal year configuration is locked after the first journal entry");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("audit verify detects structural ledger corruption beyond hash mismatch", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-corrupt-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    db.exec("PRAGMA foreign_keys = OFF");
    db.run(
      `INSERT INTO journal_entries (entry_no, transaction_date, text, rule_version, status, previous_hash, entry_hash)
       VALUES ('2026-99999', '2026-05-16', 'Corrupt entry without lines', 'corrupt-fixture', 'posted', 'GENESIS', 'bad-hash')`
    );
    db.run(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit_amount, credit_amount, text)
       VALUES (999999, 999999, 1, 0, 'orphan broken account')`
    );
    db.exec("PRAGMA foreign_keys = ON");

    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("entry has no journal lines"))).toBe(true);
    expect(result.errors.some((e) => e.includes("orphan journal_entry_id"))).toBe(true);
    expect(result.errors.some((e) => e.includes("missing account_id"))).toBe(true);
    expect(result.errors.some((e) => e.includes("foreign key violation"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  test("audit verify cross-checks stored invoice status against ledger balance", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-status-audit-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-STATUS-AUDIT",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    const posted = postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(posted.ok).toBe(true);

    db.run("DROP TRIGGER documents_no_update_issued_invoice");
    db.run("UPDATE documents SET status = 'paid' WHERE id = ?", issued.documentId!);

    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("stored status paid does not match ledger status open"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

});
