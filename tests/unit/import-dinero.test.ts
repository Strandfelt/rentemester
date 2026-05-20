// Tests: src/core/import/dinero.ts — the Dinero export parser, chart of
// accounts & company master data (#193).
//
// A Dinero data export carries the company's full chart of accounts and master
// data. The parser turns the multi-file export (`Firmaoplysninger.csv` +
// `<year>/Kontoplan.csv`) into a normalised `ImportSource`; the reconciler
// lands the chart in `accounts` and the master data in `companies`. The
// opening balance from `<year>/Posteringer.csv` is covered separately by
// import-dinero-opening.test.ts (#194); postings after the cut-over date
// remain out of scope (#195).
//
// Tests run against the synthetic fixture in examples/import-dinero/ — the real
// Dinero export is private and is never committed.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { seedAccounts, verifyAuditChain } from "../../src/core/ledger";
import { resolveSource } from "../../src/core/import/source";
import { dineroParser } from "../../src/core/import/dinero";
import { reconcileChartOfAccounts, reconcileCompanyMasterData } from "../../src/core/import/reconcile";

const FIXTURE = join(import.meta.dir, "../../examples/import-dinero");

function freshCompany(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  seedAccounts(db);
  return { root, db };
}

describe("Dinero parser: multi-file export -> normalised source", () => {
  test("declares the files it needs and parses the synthetic fixture", () => {
    expect(dineroParser.requiredFiles).toContain("Firmaoplysninger.csv");
    const parsed = dineroParser.parseSource!(resolveSource(FIXTURE));
    expect(parsed.errors).toEqual([]);
    expect(parsed.ok).toBe(true);
    expect(parsed.source!.sourceSystem).toBe("dinero");
    expect(parsed.source!.chartOfAccounts.length).toBe(17);
  });

  test("fails clearly when a required file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "rentemester-dinero-missing-"));
    try {
      const parsed = dineroParser.parseSource!(resolveSource(dir));
      expect(parsed.ok).toBe(false);
      expect(parsed.errors.join(" ")).toContain("Firmaoplysninger.csv");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("classifies every Dinero account type, splitting equity out of Passiv", () => {
    const chart = dineroParser.parseSource!(resolveSource(FIXTURE)).source!.chartOfAccounts;
    const by = (no: string) => chart.find((a) => a.accountNo === no)!;
    expect(by("1000").normalizedType).toBe("income");
    expect(by("1000").normalBalance).toBe("credit");
    expect(by("3000").normalizedType).toBe("expense");
    expect(by("3000").normalBalance).toBe("debit");
    expect(by("5510").normalizedType).toBe("asset");
    expect(by("5510").normalBalance).toBe("debit");
    expect(by("55000").normalizedType).toBe("liability");
    expect(by("55000").normalBalance).toBe("credit");
    // Equity accounts (60000-60040) sit under Passiv but classify as equity.
    expect(by("60000").normalizedType).toBe("equity");
    expect(by("60000").normalBalance).toBe("credit");
    expect(by("60040").normalizedType).toBe("equity");
  });

  test("maps Dinero Momstype codes to Rentemester VAT codes", () => {
    const chart = dineroParser.parseSource!(resolveSource(FIXTURE)).source!.chartOfAccounts;
    const by = (no: string) => chart.find((a) => a.accountNo === no)!;
    expect(by("1000").defaultVatCode).toBe("DK_SALE_25");
    expect(by("3000").defaultVatCode).toBe("DK_PURCHASE_25");
    expect(by("3010").defaultVatCode).toBe("EU_SERVICE_REVERSE_CHARGE");
    expect(by("3070").defaultVatCode).toBe("REPRESENTATION_SPECIAL");
    // An account with an empty Momstype has no default VAT code.
    expect(by("3090").defaultVatCode ?? null).toBeNull();
  });

  test("surfaces unmapped Momstype codes instead of dropping them", () => {
    const parsed = dineroParser.parseSource!(resolveSource(FIXTURE));
    const unmapped = parsed.source!.unmappedVatCodes ?? [];
    // The fixture deliberately carries codes Rentemester has no equivalent for.
    expect(unmapped.length).toBeGreaterThan(0);
    expect(unmapped.some((c) => c.startsWith("IVV"))).toBe(true);
    // An account whose Momstype is unmapped carries no default VAT code.
    const chart = parsed.source!.chartOfAccounts;
    expect(chart.find((a) => a.accountNo === "3020")!.defaultVatCode ?? null).toBeNull();
  });

  test("parses company master data from Firmaoplysninger.csv", () => {
    const md = dineroParser.parseSource!(resolveSource(FIXTURE)).source!.companyMasterData!;
    expect(md.name).toBe("Eksempel Bogføring ApS");
    expect(md.cvr).toBe("12345678");
    expect(md.address).toContain("Eksempelvej");
    expect(md.city).toBe("København Ø");
  });
});

describe("Dinero reconciliation into the live ledger", () => {
  test("creates missing accounts with correct type / normal_balance / VAT code", () => {
    const { root, db } = freshCompany("rentemester-dinero-chart-");
    try {
      const source = dineroParser.parseSource!(resolveSource(FIXTURE)).source!;
      const result = reconcileChartOfAccounts(db, source, { createdBy: "user:tester" });
      // 1000 is seeded ("Omsætning, ydelser") so it must be left intact.
      expect(result.existing).toContain("1000");
      expect(result.created).toContain("60000");

      const acct = db
        .query("SELECT type, normal_balance, default_vat_code FROM accounts WHERE account_no = ?")
        .get("60000") as { type: string; normal_balance: string; default_vat_code: string | null };
      expect(acct.type).toBe("equity");
      expect(acct.normal_balance).toBe("credit");

      const eu = db
        .query("SELECT default_vat_code FROM accounts WHERE account_no = ?")
        .get("3010") as { default_vat_code: string | null };
      expect(eu.default_vat_code).toBe("EU_SERVICE_REVERSE_CHARGE");

      // The reconciliation is audited.
      const audit = db
        .query("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'import_chart_reconcile'")
        .get() as { n: number };
      expect(audit.n).toBeGreaterThan(0);
      expect(verifyAuditChain(db).ok).toBe(true);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaves an existing account intact and reports the difference", () => {
    const { root, db } = freshCompany("rentemester-dinero-existing-");
    try {
      const source = dineroParser.parseSource!(resolveSource(FIXTURE)).source!;
      const before = db
        .query("SELECT name FROM accounts WHERE account_no = ?")
        .get("1000") as { name: string };
      reconcileChartOfAccounts(db, source, { createdBy: "user:tester" });
      const after = db
        .query("SELECT name FROM accounts WHERE account_no = ?")
        .get("1000") as { name: string };
      // The seeded account name is NOT overwritten by the Dinero name.
      expect(after.name).toBe(before.name);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports unmapped VAT codes in the reconciliation result", () => {
    const { root, db } = freshCompany("rentemester-dinero-unmapped-");
    try {
      const source = dineroParser.parseSource!(resolveSource(FIXTURE)).source!;
      const result = reconcileChartOfAccounts(db, source, { createdBy: "user:tester" });
      expect(result.unmappedVatCodes.length).toBeGreaterThan(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("populates the companies row without overwriting a non-empty field", () => {
    const { root, db } = freshCompany("rentemester-dinero-company-");
    try {
      // The company starts with the default name and no CVR.
      const source = dineroParser.parseSource!(resolveSource(FIXTURE)).source!;
      const result = reconcileCompanyMasterData(db, source, { createdBy: "user:tester" });
      expect(result.updatedFields).toContain("cvr");
      const company = db
        .query("SELECT name, cvr FROM companies WHERE id = 1")
        .get() as { name: string; cvr: string | null };
      expect(company.name).toBe("Eksempel Bogføring ApS");
      expect(company.cvr).toBe("DK12345678");

      // A second reconcile must not overwrite the now non-empty name.
      const second = reconcileCompanyMasterData(db, source, { createdBy: "user:tester" });
      expect(second.notes.join(" ")).toContain("name");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
