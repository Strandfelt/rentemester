// Tests: src/core/bank.ts (running-balance continuity, #189)
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { importBankCsv } from "../../src/core/bank";
import { listExceptions } from "../../src/core/exceptions";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-bankbal-"));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  return { root, db };
}

const HEADER = "Dato;Rentedato;Tekst;Beløb;Valuta;Saldo;Afsender;Modtagerkonto;Besked;Arkivreference;Kundereference";

// A clean statement: each Saldo equals the previous Saldo + this row's Beløb.
const CLEAN_ROWS = [
  "01.02.2026;01.02.2026;Indbetaling;1.000,00;DKK;1.000,00;ACME ApS;3000;Faktura 1;ARK-1;KND-1",
  "02.03.2026;02.03.2026;Kortbetaling;-250,00;DKK;750,00;;;Frokost;ARK-2;KND-2",
  "03.04.2026;03.04.2026;Gebyr;-50,00;DKK;700,00;;;Gebyr;ARK-3;KND-3",
];

describe("running-balance continuity (#189)", () => {
  test("a clean statement passes silently with first/last balance reported", () => {
    const { root, db } = setup();
    const csv = join(root, "clean.csv");
    writeFileSync(csv, "﻿" + [HEADER, ...CLEAN_ROWS].join("\r\n"));

    const result = importBankCsv(db, root, csv, { profile: "danske-bank" });
    expect(result.ok).toBe(true);
    expect(result.imported).toBe(3);
    expect(result.balanceWarnings ?? []).toEqual([]);
    expect(result.firstBalance).toBe(1000);
    expect(result.lastBalance).toBe(700);

    const exceptions = listExceptions(db, { status: "open" });
    expect(exceptions.rows.some((e) => e.type === "BANK_BALANCE_GAP")).toBe(false);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a statement with a removed row is flagged as a balance gap", () => {
    const { root, db } = setup();
    const csv = join(root, "gap.csv");
    // The middle -250 row is removed: the 700,00 balance no longer follows
    // from 1.000,00 by the remaining +(-50) amount.
    writeFileSync(csv, "﻿" + [HEADER, CLEAN_ROWS[0], CLEAN_ROWS[2]].join("\r\n"));

    const result = importBankCsv(db, root, csv, { profile: "danske-bank" });
    // The import still succeeds — a partial export is legitimate.
    expect(result.ok).toBe(true);
    expect(result.imported).toBe(2);
    expect((result.balanceWarnings ?? []).length).toBeGreaterThan(0);

    const exceptions = listExceptions(db, { status: "open" });
    const gap = exceptions.rows.find((e) => e.type === "BANK_BALANCE_GAP");
    expect(gap).toBeDefined();

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a generic CSV without a balance column is not balance-checked", () => {
    const { root, db } = setup();
    const csv = join(root, "generic.csv");
    writeFileSync(csv, [
      "transaction_date,booking_date,text,amount,currency,reference",
      "2026-05-16,2026-05-16,Payment,-100,DKK,R-1",
    ].join("\n"));

    const result = importBankCsv(db, root, csv);
    expect(result.ok).toBe(true);
    expect(result.balanceWarnings ?? []).toEqual([]);
    expect(result.firstBalance).toBeUndefined();

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
