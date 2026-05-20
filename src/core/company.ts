import type { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureCompanyDirs } from "./paths";
import { openDb, migrate } from "./db";
import { seedAccounts } from "./ledger";
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
};

const DEFAULT_COMPANY_SETTINGS: CompanySettings = {
  id: 1,
  name: "Rentemester company",
  country: "DK",
  currency: "DKK",
  cvr: null,
  fiscalYearStartMonth: 1,
  fiscalYearLabelStrategy: "end-year",
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
  "  block_if_uncertain: true\n";

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
    `SELECT id, name, country, currency, cvr, fiscal_year_start_month, fiscal_year_label_strategy
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
  };
}
