import type { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureCompanyDirs } from "./paths";
import { openDb, migrate } from "./db";
import { seedAccounts } from "./ledger";
import { insertAuditLog } from "./actor";
import {
  lookupCvrCompany,
  normalizeCvrNumber,
  type CvrCompanyInfo,
  type CvrLookupOptions,
} from "./cvr";
import {
  registerWorkspaceCompany,
  slugifyCompanyName,
  isValidSlug,
} from "./workspace";

export type FiscalYearLabelStrategy = "end-year" | "start-year" | "span";

export type CompanySettings = {
  id: number;
  name: string;
  country: string;
  currency: string;
  cvr: string | null;
  fiscalYearStartMonth: number;
  fiscalYearLabelStrategy: FiscalYearLabelStrategy;
  /** CVR-register stamdata, last written by `company sync-cvr`. */
  address: string | null;
  postalCode: string | null;
  city: string | null;
  companyForm: string | null;
  industryCode: string | null;
  industryText: string | null;
  cvrStatus: string | null;
  auditWaived: boolean | null;
  /** ISO timestamp the CVR stamdata above was last synced; null when never. */
  cvrSyncedAt: string | null;
};

const DEFAULT_COMPANY_SETTINGS: CompanySettings = {
  id: 1,
  name: "Rentemester company",
  country: "DK",
  currency: "DKK",
  cvr: null,
  fiscalYearStartMonth: 1,
  fiscalYearLabelStrategy: "end-year",
  address: null,
  postalCode: null,
  city: null,
  companyForm: null,
  industryCode: null,
  industryText: null,
  cvrStatus: null,
  auditWaived: null,
  cvrSyncedAt: null,
};

export function normalizeCvr(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const stripped = trimmed.toUpperCase().replace(/^DK/, "");
  if (!/^\d{8}$/.test(stripped)) {
    throw new Error(`CVR must be 8 digits (optionally prefixed with DK), got: ${value}`);
  }
  return `DK${stripped}`;
}

export function normalizeFiscalYearStartMonth(value?: number | string | null) {
  const month = typeof value === "string" ? Number(value) : value;
  if (!Number.isInteger(month) || (month ?? 0) < 1 || (month ?? 0) > 12) return null;
  return month;
}

export function normalizeFiscalYearLabelStrategy(value?: string | null): FiscalYearLabelStrategy | null {
  if (value === "end-year" || value === "start-year" || value === "span") return value;
  return null;
}

const DEFAULT_POLICY_YAML =
  "company_policy:\n" +
  "  country: DK\n" +
  "  currency: DKK\n" +
  "  allow_direct_sql_write: false\n" +
  "  block_if_uncertain: true\n" +
  "\n" +
  "# Aktører der må køre muterende kommandoer med et eksplicit --actor-flag.\n" +
  "# Hver muterende kommando kræver en actor; et eksplicit --actor skal stå her,\n" +
  "# ellers afvises kaldet. Tilføj din egen bruger/agent i listerne nedenfor.\n" +
  "actor_allowlist:\n" +
  "  users:\n" +
  "    - user:ejer\n" +
  "  agents:\n" +
  "    - agent:rentemester-bookkeeper\n" +
  "  systems:\n" +
  "    - system:rentemester\n";

export type CompanyInitOptions = {
  /** Display name stored in the ledger's `companies` row (id = 1). */
  name?: string;
  cvr?: string | null;
  fiscalYearStartMonth?: number | string | null;
  fiscalYearLabelStrategy?: string | null;
};

export type CompanyInitResult = {
  companyRoot: string;
  dbPath: string;
};

/**
 * Initialises a Rentemester company *volume* at `companyRoot`:
 * creates the directory tree, opens + migrates the ledger DB, seeds the
 * standard chart of accounts, writes the company row and a default
 * `policy.yaml`, and records an `init` audit event.
 *
 * This is the single source of truth for company initialisation — `rentemester
 * init` (raw path), `createCompany` (workspace), and later the MCP tools and
 * the cockpit API all call this. It does NOT touch any workspace manifest.
 *
 * Throws on invalid fiscal-year input so callers can surface a clear error.
 */
export function initialiseCompanyVolume(
  companyRoot: string,
  options: CompanyInitOptions = {},
): CompanyInitResult {
  if (options.fiscalYearStartMonth !== undefined && options.fiscalYearStartMonth !== null) {
    if (normalizeFiscalYearStartMonth(options.fiscalYearStartMonth) === null) {
      throw new Error("fiscalYearStartMonth must be an integer between 1 and 12");
    }
  }
  if (options.fiscalYearLabelStrategy !== undefined && options.fiscalYearLabelStrategy !== null) {
    if (normalizeFiscalYearLabelStrategy(options.fiscalYearLabelStrategy) === null) {
      throw new Error(
        "fiscalYearLabelStrategy must be one of end-year, start-year, span",
      );
    }
  }

  const p = ensureCompanyDirs(companyRoot);
  const db = openDb(p.db);
  try {
    migrate(db);
    seedAccounts(db);
    const cvr = normalizeCvr(options.cvr);
    const fiscalYearStartMonth =
      normalizeFiscalYearStartMonth(options.fiscalYearStartMonth) ?? 1;
    const fiscalYearLabelStrategy =
      normalizeFiscalYearLabelStrategy(options.fiscalYearLabelStrategy) ?? "end-year";
    const name = options.name?.trim() || DEFAULT_COMPANY_SETTINGS.name;
    db.query(
      `INSERT INTO companies (id, name, cvr, fiscal_year_start_month, fiscal_year_label_strategy)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         cvr = excluded.cvr,
         fiscal_year_start_month = excluded.fiscal_year_start_month,
         fiscal_year_label_strategy = excluded.fiscal_year_label_strategy`,
    ).run(name, cvr, fiscalYearStartMonth, fiscalYearLabelStrategy);
    const policy = join(p.config, "policy.yaml");
    if (!existsSync(policy)) writeFileSync(policy, DEFAULT_POLICY_YAML);
    db.run(
      "INSERT INTO audit_log (event_type, entity_type, message) VALUES ('init','company','Company volume initialized')",
    );
  } finally {
    db.close();
  }
  return { companyRoot, dbPath: p.db };
}

/**
 * Rentemester currently models VAT settlement on a quarterly cadence — the
 * `vat_quarter` accounting period. There is no per-company VAT-period setting
 * yet, so onboarding surfaces this assumption explicitly so the owner can
 * confirm it fits their registration (some businesses file monthly or
 * half-yearly) before they start booking.
 */
export const ASSUMED_VAT_PERIOD = "kvartal" as const;

export type CompanyOnboardingSummary = {
  /** Display name stored in the ledger. */
  name: string;
  cvr: string | null;
  /** Month (1-12) the fiscal year starts in. */
  fiscalYearStartMonth: number;
  fiscalYearLabelStrategy: FiscalYearLabelStrategy;
  /** The VAT settlement cadence Rentemester currently assumes. */
  vatPeriod: typeof ASSUMED_VAT_PERIOD;
  /** Number of accounts seeded into the chart of accounts. */
  accountCount: number;
};

/**
 * Reads a post-`init` onboarding summary from a company volume: the seeded
 * chart-of-accounts size plus the settings a new owner must confirm (VAT
 * period, fiscal year). Pure read — opens the ledger read-only.
 */
export function summariseCompanyVolume(companyRoot: string): CompanyOnboardingSummary {
  const dbPath = join(companyRoot, "data", "ledger.sqlite");
  const db = openDb(dbPath);
  try {
    const settings = getCompanySettings(db);
    const row = db.query("SELECT COUNT(*) AS n FROM accounts").get() as { n: number };
    return {
      name: settings.name,
      cvr: settings.cvr,
      fiscalYearStartMonth: settings.fiscalYearStartMonth,
      fiscalYearLabelStrategy: settings.fiscalYearLabelStrategy,
      vatPeriod: ASSUMED_VAT_PERIOD,
      accountCount: Number(row?.n ?? 0),
    };
  } finally {
    db.close();
  }
}

export type CreateCompanyOptions = CompanyInitOptions & {
  /** Required: display name; also the basis for an auto-derived slug. */
  name: string;
  /** Optional explicit slug; auto-derived from `name` when omitted. */
  slug?: string;
};

export type CreateCompanyResult = CompanyInitResult & {
  slug: string;
  name: string;
};

/**
 * Creates a new company *inside a workspace*: derives/validates a slug, builds
 * the company volume under `<workspaceRoot>/<slug>/`, initialises its ledger,
 * and registers the company in the workspace manifest.
 *
 * Throws if the slug is invalid or already registered. The CLI `company add`
 * command, the future MCP tools and the cockpit API all call this.
 */
export function createCompany(
  workspaceRoot: string,
  options: CreateCompanyOptions,
): CreateCompanyResult {
  const name = options.name?.trim();
  if (!name) throw new Error("createCompany requires a non-empty name");
  const slug = options.slug?.trim() || slugifyCompanyName(name);
  if (!slug || !isValidSlug(slug)) {
    throw new Error(
      `cannot derive a valid slug from '${name}' — pass an explicit slug (lowercase letters, digits, dashes)`,
    );
  }
  const companyRoot = join(workspaceRoot, slug);
  if (existsSync(join(companyRoot, "data", "ledger.sqlite"))) {
    throw new Error(`a company already exists at ${companyRoot}`);
  }
  const init = initialiseCompanyVolume(companyRoot, {
    name,
    cvr: options.cvr,
    fiscalYearStartMonth: options.fiscalYearStartMonth,
    fiscalYearLabelStrategy: options.fiscalYearLabelStrategy,
  });
  // registerWorkspaceCompany throws on a duplicate slug, so the manifest and
  // the on-disk directory cannot drift apart silently.
  registerWorkspaceCompany(workspaceRoot, {
    slug,
    name,
    createdAt: new Date().toISOString(),
    archived: false,
  });
  return { ...init, slug, name };
}

export function getCompanySettings(db: Database): CompanySettings {
  const row = db.query(
    `SELECT id, name, country, currency, cvr, fiscal_year_start_month, fiscal_year_label_strategy,
            address, postal_code, city, company_form, industry_code, industry_text,
            cvr_status, audit_waived, cvr_synced_at
       FROM companies
      ORDER BY id ASC
      LIMIT 1`
  ).get() as {
    id: number;
    name: string;
    country: string;
    currency: string;
    cvr: string | null;
    fiscal_year_start_month: number;
    fiscal_year_label_strategy: FiscalYearLabelStrategy;
    address: string | null;
    postal_code: string | null;
    city: string | null;
    company_form: string | null;
    industry_code: string | null;
    industry_text: string | null;
    cvr_status: string | null;
    audit_waived: number | null;
    cvr_synced_at: string | null;
  } | null;

  if (!row) return DEFAULT_COMPANY_SETTINGS;
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    currency: row.currency,
    cvr: normalizeCvr(row.cvr),
    fiscalYearStartMonth: normalizeFiscalYearStartMonth(row.fiscal_year_start_month) ?? 1,
    fiscalYearLabelStrategy: normalizeFiscalYearLabelStrategy(row.fiscal_year_label_strategy) ?? "end-year",
    address: row.address,
    postalCode: row.postal_code,
    city: row.city,
    companyForm: row.company_form,
    industryCode: row.industry_code,
    industryText: row.industry_text,
    cvrStatus: row.cvr_status,
    auditWaived: row.audit_waived === null ? null : row.audit_waived === 1,
    cvrSyncedAt: row.cvr_synced_at,
  };
}

export type SyncCompanyFromCvrResult = {
  ok: boolean;
  /** The CVR number that was looked up (8 digits, no DK prefix). */
  cvr?: string;
  company?: CvrCompanyInfo;
  /** True when the snapshot came from the local cache, not a fresh fetch. */
  cached?: boolean;
  /** Names of the `companies` columns whose value actually changed. */
  updatedFields?: string[];
  /**
   * The fiscal-year start month as configured vs. as registered in CVR. Sync
   * never rewrites the fiscal year — it is a locked accounting setting — it
   * only reports a mismatch so the user can correct it deliberately.
   */
  fiscalYearStartMonth?: { current: number; cvr: number | null; matches: boolean };
  errors: string[];
};

/**
 * Refreshes the owning company's CVR-register stamdata: looks the company's own
 * CVR number up and writes name/address/branche/form/status into the
 * `companies` row. The fiscal-year configuration is never touched — it is
 * locked after the first journal entry — but a mismatch is reported.
 */
export async function syncCompanyFromCvr(
  db: Database,
  options: CvrLookupOptions = {},
): Promise<SyncCompanyFromCvrResult> {
  const before = getCompanySettings(db);
  const cvrNumber = normalizeCvrNumber(before.cvr);
  if (!cvrNumber) {
    return {
      ok: false,
      errors: [
        "virksomheden har intet gyldigt CVR-nummer registreret — sæt det via 'init --cvr' / 'company add --cvr'",
      ],
    };
  }

  const lookup = await lookupCvrCompany(db, cvrNumber, options);
  if (!lookup.ok || !lookup.company) {
    return { ok: false, cvr: cvrNumber, errors: lookup.errors };
  }

  const info = lookup.company;
  const syncedAt = options.asOf ?? new Date().toISOString();
  const auditWaived = info.auditWaived === null ? null : info.auditWaived ? 1 : 0;

  db.query(
    `UPDATE companies SET
       name = ?, address = ?, postal_code = ?, city = ?, company_form = ?,
       industry_code = ?, industry_text = ?, cvr_status = ?, audit_waived = ?,
       cvr_synced_at = ?
     WHERE id = (SELECT id FROM companies ORDER BY id ASC LIMIT 1)`,
  ).run(
    info.name,
    info.address,
    info.postalCode,
    info.city,
    info.companyFormShort,
    info.industryCode,
    info.industryText,
    info.status,
    auditWaived,
    syncedAt,
  );

  const after = getCompanySettings(db);
  const updatedFields: string[] = [];
  const compare: Array<[string, unknown, unknown]> = [
    ["name", before.name, after.name],
    ["address", before.address, after.address],
    ["postalCode", before.postalCode, after.postalCode],
    ["city", before.city, after.city],
    ["companyForm", before.companyForm, after.companyForm],
    ["industryCode", before.industryCode, after.industryCode],
    ["industryText", before.industryText, after.industryText],
    ["cvrStatus", before.cvrStatus, after.cvrStatus],
    ["auditWaived", before.auditWaived, after.auditWaived],
  ];
  for (const [field, prev, next] of compare) {
    if (prev !== next) updatedFields.push(field);
  }

  insertAuditLog(db, {
    eventType: "company_cvr_sync",
    entityType: "company",
    entityId: after.id,
    message:
      updatedFields.length > 0
        ? `Synced company stamdata from CVR ${cvrNumber}: ${updatedFields.join(", ")}`
        : `Synced company stamdata from CVR ${cvrNumber} (no changes)`,
  });

  return {
    ok: true,
    cvr: cvrNumber,
    company: info,
    cached: lookup.cached,
    updatedFields,
    fiscalYearStartMonth: {
      current: before.fiscalYearStartMonth,
      cvr: info.fiscalYearStartMonth,
      matches:
        info.fiscalYearStartMonth === null ||
        info.fiscalYearStartMonth === before.fiscalYearStartMonth,
    },
    errors: [],
  };
}
