import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { hashEntry, seedAccounts, verifyAuditChain } from "../../src/core/ledger";

describe("audit verify", () => {
  test("flags an unbalanced journal entry even when the stored hash chain matches", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-verify-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const entry = {
      entry_no: "2026-00001",
      transaction_date: "2026-05-16",
      text: "Corrupt unbalanced entry",
      source_bank_transaction_id: null,
      document_id: null,
      currency: "DKK",
      amount_foreign: null,
      amount_dkk: null,
      fx_rate_to_dkk: null,
      rule_version: "dk-v0.0.1",
      created_by: "system",
      created_by_program: "rentemester",
      status: "posted",
      reversal_of_entry_id: null,
    };
    const lines = [
      { account_no: "2000", debit_amount: 100, credit_amount: 0, vat_code: null, text: "Bank" },
      { account_no: "1000", debit_amount: 0, credit_amount: 90, vat_code: null, text: "Income" },
    ];
    const entryHash = hashEntry({ ...entry, lines }, "GENESIS");

    db.run(
      `INSERT INTO journal_entries (
        entry_no, transaction_date, text, source_bank_transaction_id, document_id,
        currency, amount_foreign, amount_dkk, fx_rate_to_dkk,
        rule_version, created_by, created_by_program, status, previous_hash, entry_hash
      ) VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
      entry.entry_no,
      entry.transaction_date,
      entry.text,
      entry.currency,
      entry.rule_version,
      entry.created_by,
      entry.created_by_program,
      entry.status,
      "GENESIS",
      entryHash,
    );

    const inserted = db.query("SELECT id FROM journal_entries WHERE entry_no = ?").get(entry.entry_no) as { id: number };
    const bank = db.query("SELECT id FROM accounts WHERE account_no = '2000'").get() as { id: number };
    const income = db.query("SELECT id FROM accounts WHERE account_no = '1000'").get() as { id: number };
    db.run(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit_amount, credit_amount, vat_code, currency, text)
       VALUES (?, ?, 100, 0, NULL, 'DKK', 'Bank')`,
      inserted.id,
      bank.id,
    );
    db.run(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit_amount, credit_amount, vat_code, currency, text)
       VALUES (?, ?, 0, 90, NULL, 'DKK', 'Income')`,
      inserted.id,
      income.id,
    );

    const audit = verifyAuditChain(db);
    expect(audit.ok).toBe(false);
    expect(audit.errors.some((error) => error.includes("entry is unbalanced"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
