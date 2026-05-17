import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { importBankCsv } from "../../src/core/bank";

describe("bank import", () => {
  test("imports valid bank rows and skips deterministic duplicates", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-"));
    const csv = join(root, "transactions.csv");
    writeFileSync(csv, [
      "transaction_date,booking_date,text,amount,currency,reference",
      "2026-05-16,2026-05-17,Card payment,-1250,DKK,REF-1",
      "2026-05-18,2026-05-18,Customer payment,2500,DKK,REF-2"
    ].join("\n"));

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const first = importBankCsv(db, root, csv);
    expect(first.ok).toBe(true);
    expect(first.imported).toBe(2);
    expect(first.skippedDuplicates).toBe(0);

    const second = importBankCsv(db, root, csv);
    expect(second.ok).toBe(true);
    expect(second.imported).toBe(0);
    expect(second.skippedDuplicates).toBe(2);

    const rows = db.query("SELECT transaction_date, text, amount, import_batch_id, transaction_hash FROM bank_transactions ORDER BY id ASC").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].transaction_date).toBe("2026-05-16");
    expect(rows[0].transaction_hash).toBeTruthy();
    expect(rows[1].text).toBe("Customer payment");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("imports non-DKK rows when DKK amount and FX rate are supplied", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-fx-"));
    const csv = join(root, "fx.csv");
    writeFileSync(csv, [
      "transaction_date,booking_date,text,amount,currency,amount_dkk,fx_rate_to_dkk,reference",
      "2026-05-19,2026-05-19,Stripe payout,100,EUR,746,7.46,EUR-REF-1"
    ].join("\n"));

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const result = importBankCsv(db, root, csv);
    expect(result.ok).toBe(true);
    const rows = db.query("SELECT currency, amount, amount_dkk, fx_rate_to_dkk FROM bank_transactions ORDER BY id ASC").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ currency: "EUR", amount: 100, amount_dkk: 746, fx_rate_to_dkk: 7.46 });

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects malformed bank rows", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-bad-"));
    const csv = join(root, "bad.csv");
    writeFileSync(csv, [
      "transaction_date,booking_date,text,amount,currency,amount_dkk,fx_rate_to_dkk,reference",
      "16-05-2026,,,-abc,EUR,,,REF-1"
    ].join("\n"));

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    const result = importBankCsv(db, root, csv);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("transactionDate"))).toBe(true);
    expect(result.errors.some((e) => e.includes("amount"))).toBe(true);
    expect(result.errors.some((e) => e.includes("amountDkk"))).toBe(true);
    expect(result.errors.some((e) => e.includes("fxRateToDkk"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
