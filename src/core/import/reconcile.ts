// Import framework — chart-of-accounts & company-master-data reconciliation.
// Issue #193 (epic #173).
//
// A parser turns an export into a normalised `ImportSource`. Reconciliation
// LANDS that source into the live company ledger:
//
//  - `reconcileChartOfAccounts` walks `source.chartOfAccounts` and, for each
//    account, INSERTs it into the `accounts` table if it is missing. An
//    existing account is left INTACT — its name / type / VAT code are never
//    overwritten — but any difference against the source is reported. This is
//    the prerequisite that lets #194 post a Dinero opening balance, because
//    `postOpeningBalance` re-validates every line against the live `accounts`.
//
//  - `reconcileCompanyMasterData` populates the `companies` row (id = 1) from
//    `source.companyMasterData`. A non-empty field is never overwritten unless
//    `overwrite` is explicitly requested.
//
// Both are DETERMINISTIC and AUDITED: accounts are processed in source order,
// and an `audit_log` row records what each reconciliation did.

import type { Database } from "bun:sqlite";
import { insertAuditLog, type ResolveActorInput } from "../actor";
import { normalizeCvr } from "../company";
import type {
  ChartReconciliationResult,
  CompanyReconciliationResult,
  ImportSource,
} from "./types";

const CHART_RULE = "DK-IMPORT-CHART-RECONCILE-001";
const COMPANY_RULE = "DK-IMPORT-COMPANY-RECONCILE-001";

type ReconcileOptions = ResolveActorInput;

/**
 * Reconciles `source.chartOfAccounts` into the live `accounts` table: creates
 * accounts that do not yet exist, leaves existing accounts untouched, and
 * reports every difference and unmapped VAT code. Returns a deterministic
 * summary; the operation is wrapped in a single transaction and audited.
 */
export function reconcileChartOfAccounts(
  db: Database,
  source: ImportSource,
  options: ReconcileOptions = {},
): ChartReconciliationResult {
  const chart = Array.isArray(source?.chartOfAccounts) ? source.chartOfAccounts : [];
  const created: string[] = [];
  const existing: string[] = [];
  const differences: string[] = [];

  const findAccount = db.prepare(
    "SELECT name, type, normal_balance, default_vat_code FROM accounts WHERE account_no = ?",
  );
  const insertAccount = db.prepare(
    "INSERT INTO accounts (account_no, name, type, normal_balance, default_vat_code) VALUES (?, ?, ?, ?, ?)",
  );

  db.transaction(() => {
    for (const account of chart) {
      const accountNo = typeof account?.accountNo === "string" ? account.accountNo.trim() : "";
      if (!accountNo) continue;
      const live = findAccount.get(accountNo) as
        | { name: string; type: string; normal_balance: string; default_vat_code: string | null }
        | null;

      if (live) {
        existing.push(accountNo);
        // Existing accounts are authoritative: report mismatches, change nothing.
        if (account.name && account.name.trim() !== live.name) {
          differences.push(
            `account ${accountNo}: name differs (live '${live.name}' vs source '${account.name.trim()}') — kept live`,
          );
        }
        if (account.normalizedType && account.normalizedType !== live.type) {
          differences.push(
            `account ${accountNo}: type differs (live '${live.type}' vs source '${account.normalizedType}') — kept live`,
          );
        }
        const sourceVat = account.defaultVatCode ?? null;
        if (sourceVat && sourceVat !== (live.default_vat_code ?? null)) {
          differences.push(
            `account ${accountNo}: default_vat_code differs (live '${live.default_vat_code ?? ""}' vs source '${sourceVat}') — kept live`,
          );
        }
        continue;
      }

      // Missing account: create it. A classified source account carries the
      // Rentemester type / normal balance; anything unclassified is rejected.
      if (!account.normalizedType || !account.normalBalance) {
        differences.push(
          `account ${accountNo}: not created — source did not classify it onto a Rentemester account type`,
        );
        continue;
      }
      insertAccount.run(
        accountNo,
        account.name?.trim() || `Konto ${accountNo}`,
        account.normalizedType,
        account.normalBalance,
        account.defaultVatCode ?? null,
      );
      created.push(accountNo);
    }

    insertAuditLog(db, {
      eventType: "import_chart_reconcile",
      entityType: "accounts",
      message:
        `Reconciled chart of accounts from '${source.sourceSystem}': ` +
        `${created.length} created, ${existing.length} already present, ` +
        `${differences.length} difference(s)`,
      createdBy: options.createdBy,
      createdByProgram: options.createdByProgram,
    });
  })();

  const unmappedVatCodes = Array.isArray(source?.unmappedVatCodes)
    ? [...source.unmappedVatCodes]
    : [];

  return { created, existing, differences, unmappedVatCodes };
}

/**
 * Reconciles `source.companyMasterData` into the `companies` row (id = 1).
 * Creates the row if it does not exist; otherwise populates only the fields
 * that are currently empty. A non-empty field is left intact unless
 * `options.overwrite` is set. Returns a deterministic summary and is audited.
 *
 * Note: the `companies` schema stores `name` and `cvr` only. Address / city /
 * email and the other Dinero `Firmaoplysninger.csv` fields have no column —
 * they are carried in the audit message so the migration stays traceable.
 */
export function reconcileCompanyMasterData(
  db: Database,
  source: ImportSource,
  options: ReconcileOptions & { overwrite?: boolean } = {},
): CompanyReconciliationResult {
  const md = source?.companyMasterData;
  const updatedFields: string[] = [];
  const notes: string[] = [];
  if (!md) {
    return { updatedFields, notes: ["source carried no company master data"] };
  }

  // Normalise the CVR up front so an invalid value fails loudly here rather
  // than silently writing junk into the ledger.
  let cvr: string | null = null;
  if (md.cvr) {
    try {
      cvr = normalizeCvr(md.cvr);
    } catch {
      notes.push(`cvr '${md.cvr}' is not a valid Danish CVR — skipped`);
    }
  }

  db.transaction(() => {
    const row = db
      .query("SELECT name, cvr FROM companies WHERE id = 1")
      .get() as { name: string | null; cvr: string | null } | null;

    const setName = (value: string, current: string | null): boolean => {
      const isDefault = !current || current.trim() === "" || current === "Rentemester company";
      if (!isDefault && !options.overwrite) {
        notes.push(`name kept ('${current}') — source value '${value}' not applied`);
        return false;
      }
      return true;
    };
    const setCvr = (current: string | null): boolean => {
      if (current && current.trim() !== "" && !options.overwrite) {
        notes.push(`cvr kept ('${current}') — source value not applied`);
        return false;
      }
      return true;
    };

    if (!row) {
      // No company row yet — create it directly from the source.
      const name = md.name?.trim() || "Rentemester company";
      db.prepare("INSERT INTO companies (id, name, cvr) VALUES (1, ?, ?)").run(name, cvr);
      if (md.name?.trim()) updatedFields.push("name");
      if (cvr) updatedFields.push("cvr");
    } else {
      const applyName = md.name?.trim() ? setName(md.name.trim(), row.name) : false;
      const applyCvr = cvr ? setCvr(row.cvr) : false;
      if (applyName) {
        db.prepare("UPDATE companies SET name = ? WHERE id = 1").run(md.name!.trim());
        updatedFields.push("name");
      }
      if (applyCvr) {
        db.prepare("UPDATE companies SET cvr = ? WHERE id = 1").run(cvr);
        updatedFields.push("cvr");
      }
    }

    // Schema has no columns for these — record them for the audit trail.
    const carried: string[] = [];
    if (md.address) carried.push(`address='${md.address}'`);
    if (md.postalCode || md.city) carried.push(`city='${[md.postalCode, md.city].filter(Boolean).join(" ")}'`);
    if (md.email) carried.push(`email='${md.email}'`);
    if (md.phone) carried.push(`phone='${md.phone}'`);
    if (md.website) carried.push(`website='${md.website}'`);

    insertAuditLog(db, {
      eventType: "import_company_reconcile",
      entityType: "company",
      entityId: 1,
      message:
        `Reconciled company master data from '${source.sourceSystem}': ` +
        `updated [${updatedFields.join(", ") || "nothing"}]` +
        (carried.length > 0 ? `; export also carried ${carried.join(", ")}` : ""),
      createdBy: options.createdBy,
      createdByProgram: options.createdByProgram,
    });
  })();

  return { updatedFields, notes };
}

/** Stable rule identifiers for the reconciliation steps. */
export const RECONCILE_RULES = { CHART: CHART_RULE, COMPANY: COMPANY_RULE } as const;
