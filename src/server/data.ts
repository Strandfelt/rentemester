// Read-side data assembly for the cockpit backend (#170).
//
// Every figure here is computed by an existing core function — this module
// only opens the right ledger, calls core, and shapes the JSON. No business
// logic is duplicated and nothing here mutates a ledger.

import { existsSync } from "node:fs";
import { companyPaths } from "../core/paths";
import { openDb, migrate } from "../core/db";
import { getCompanySettings } from "../core/company";
import { fiscalYearForDate } from "../core/fiscal-year";
import { buildInvoiceList, buildOverdueInvoiceList } from "../core/invoice-list";
import { listBankTransactions } from "../core/reconciliation";
import { listExceptions } from "../core/exceptions";
import { buildVatReport } from "../core/vat";
import { getBackupComplianceStatus } from "../core/system-backups";
import { listRecentAuditLog } from "../core/audit-log";
import { verifyAuditChain } from "../core/ledger";
import {
  companyRootForSlug,
  findWorkspaceCompany,
  listWorkspaceCompanies,
  type WorkspaceCompanyEntry,
} from "../core/workspace";
import { ApiError } from "./errors";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today as YYYY-MM-DD (UTC). The clock lives here, not in core. */
export function todayIsoDate(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Validates an optional `?as-of=` query value, defaulting to today. */
export function resolveAsOfDate(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw.length === 0) return todayIsoDate();
  if (!ISO_DATE_RE.test(raw)) {
    throw ApiError.badRequest("asOf must be a YYYY-MM-DD date");
  }
  return raw;
}

function quarterPeriodForDate(asOfDate: string): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(asOfDate);
  if (!m) return { start: asOfDate, end: asOfDate };
  const year = parseInt(m[1]!, 10);
  const month = parseInt(m[2]!, 10);
  const quarter = Math.floor((month - 1) / 3) + 1;
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    start: `${year}-${pad(startMonth)}-01`,
    end: `${year}-${pad(endMonth)}-${pad(lastDay)}`,
  };
}

function daysBetween(a: string, b: string): number {
  const pa = /^(\d{4})-(\d{2})-(\d{2})/.exec(a);
  const pb = /^(\d{4})-(\d{2})-(\d{2})/.exec(b);
  if (!pa || !pb) return 0;
  const da = Date.UTC(parseInt(pa[1]!, 10), parseInt(pa[2]!, 10) - 1, parseInt(pa[3]!, 10));
  const db = Date.UTC(parseInt(pb[1]!, 10), parseInt(pb[2]!, 10) - 1, parseInt(pb[3]!, 10));
  return Math.round((db - da) / 86400000);
}

// --------------------------------------------------------------------------
// Per-company summary (one row in the portfolio overview)
// --------------------------------------------------------------------------

export type CompanySummary = {
  slug: string;
  name: string;
  cvr: string | null;
  archived: boolean;
  /** True when the slug is registered but has no ledger on disk. */
  ledgerMissing: boolean;
  openInvoiceCount: number;
  openInvoiceTotal: number;
  overdueInvoiceCount: number;
  unlinkedBankCount: number;
  openExceptionCount: number;
  /** Estimated net VAT payable for the quarter containing `asOf`. */
  netVatPayable: number;
  auditChainOk: boolean;
};

function summariseCompany(
  workspaceRoot: string,
  entry: WorkspaceCompanyEntry,
  asOfDate: string,
): CompanySummary {
  const companyRoot = companyRootForSlug(workspaceRoot, entry.slug);
  const dbPath = companyPaths(companyRoot).db;
  if (!existsSync(dbPath)) {
    return {
      slug: entry.slug,
      name: entry.name,
      cvr: null,
      archived: entry.archived,
      ledgerMissing: true,
      openInvoiceCount: 0,
      openInvoiceTotal: 0,
      overdueInvoiceCount: 0,
      unlinkedBankCount: 0,
      openExceptionCount: 0,
      netVatPayable: 0,
      auditChainOk: false,
    };
  }

  const db = openDb(dbPath);
  try {
    migrate(db);
    const company = getCompanySettings(db);
    const invoices = buildInvoiceList(db, { status: "open", asOfDate });
    const overdue = buildOverdueInvoiceList(db, { asOfDate });
    const unlinked = listBankTransactions(db, { status: "unmatched" });
    const exceptions = listExceptions(db, { status: "open" });
    const period = quarterPeriodForDate(asOfDate);
    const vat = buildVatReport(db, period.start, period.end);
    const audit = verifyAuditChain(db);
    return {
      slug: entry.slug,
      name: company.name,
      cvr: company.cvr,
      archived: entry.archived,
      ledgerMissing: false,
      openInvoiceCount: invoices.count,
      openInvoiceTotal: invoices.rows.reduce((acc, r) => acc + r.openBalance, 0),
      overdueInvoiceCount: overdue.count,
      unlinkedBankCount: unlinked.count,
      openExceptionCount: exceptions.count,
      netVatPayable: vat.netVatPayable,
      auditChainOk: audit.ok,
    };
  } finally {
    db.close();
  }
}

export type PortfolioOverview = {
  workspace: string;
  asOf: string;
  companyCount: number;
  totals: {
    openInvoiceCount: number;
    openInvoiceTotal: number;
    overdueInvoiceCount: number;
    unlinkedBankCount: number;
    openExceptionCount: number;
    netVatPayable: number;
  };
  companies: CompanySummary[];
};

/** Aggregates one summary per workspace company plus portfolio-wide totals. */
export function buildPortfolioOverview(
  workspaceRoot: string,
  asOfDate: string,
): PortfolioOverview {
  const entries = listWorkspaceCompanies(workspaceRoot);
  const companies = entries.map((entry) =>
    summariseCompany(workspaceRoot, entry, asOfDate),
  );
  const totals = companies.reduce(
    (acc, c) => ({
      openInvoiceCount: acc.openInvoiceCount + c.openInvoiceCount,
      openInvoiceTotal: acc.openInvoiceTotal + c.openInvoiceTotal,
      overdueInvoiceCount: acc.overdueInvoiceCount + c.overdueInvoiceCount,
      unlinkedBankCount: acc.unlinkedBankCount + c.unlinkedBankCount,
      openExceptionCount: acc.openExceptionCount + c.openExceptionCount,
      netVatPayable: acc.netVatPayable + c.netVatPayable,
    }),
    {
      openInvoiceCount: 0,
      openInvoiceTotal: 0,
      overdueInvoiceCount: 0,
      unlinkedBankCount: 0,
      openExceptionCount: 0,
      netVatPayable: 0,
    },
  );
  return {
    workspace: workspaceRoot,
    asOf: asOfDate,
    companyCount: companies.length,
    totals,
    companies,
  };
}

// --------------------------------------------------------------------------
// Per-company dashboard data
// --------------------------------------------------------------------------

export type CompanyDashboardData = ReturnType<typeof buildCompanyDashboardData>;

/**
 * Per-company dashboard data — the same figures the static HTML dashboard
 * (`src/core/dashboard.ts`) renders, returned as JSON for the cockpit SPA.
 *
 * Throws `ApiError.notFound` when the slug is not registered or the ledger is
 * missing on disk.
 */
export function buildCompanyDashboardData(
  workspaceRoot: string,
  slug: string,
  asOfDate: string,
) {
  const entry = findWorkspaceCompany(workspaceRoot, slug);
  if (!entry) {
    throw ApiError.notFound(`no company with slug '${slug}' in the workspace`);
  }
  const companyRoot = companyRootForSlug(workspaceRoot, slug);
  const dbPath = companyPaths(companyRoot).db;
  if (!existsSync(dbPath)) {
    throw ApiError.notFound(`company '${slug}' has no ledger`);
  }

  const db = openDb(dbPath);
  try {
    migrate(db);
    const company = getCompanySettings(db);
    const invoices = buildInvoiceList(db, { status: "open", asOfDate });
    const overdueInvoices = buildOverdueInvoiceList(db, { asOfDate });
    const unlinkedBank = listBankTransactions(db, { status: "unmatched" });
    const exceptions = listExceptions(db, { status: "open" });
    const period = quarterPeriodForDate(asOfDate);
    const vatPeriod = buildVatReport(db, period.start, period.end);
    const vatDaysRemaining = daysBetween(asOfDate, period.end);
    const recentActivity = listRecentAuditLog(db, 10);
    const backup = getBackupComplianceStatus(db, companyRoot, asOfDate);
    const audit = verifyAuditChain(db);

    return {
      slug: entry.slug,
      asOf: asOfDate,
      company: {
        name: company.name,
        cvr: company.cvr,
        country: company.country,
        currency: company.currency,
        fiscalYearStartMonth: company.fiscalYearStartMonth,
        fiscalYearLabelStrategy: company.fiscalYearLabelStrategy,
      },
      invoices: {
        count: invoices.count,
        openTotal: invoices.rows.reduce((acc, r) => acc + r.openBalance, 0),
        rows: invoices.rows,
      },
      overdueInvoices: {
        count: overdueInvoices.count,
        rows: overdueInvoices.rows,
      },
      unlinkedBank: { count: unlinkedBank.count },
      exceptions: {
        count: exceptions.count,
        rows: exceptions.rows.map((row: any) => ({
          id: row.id,
          type: row.type,
          severity: row.severity,
          status: row.status,
          message: row.message,
        })),
      },
      vat: {
        periodStart: period.start,
        periodEnd: period.end,
        netVatPayable: vatPeriod.netVatPayable,
        daysRemaining: vatDaysRemaining,
        errors: vatPeriod.errors ?? [],
      },
      backup: {
        backupsFound: backup.backupsFound,
        latestBackupAt: backup.latestBackupAt,
        daysSinceLatestBackup: backup.daysSinceLatestBackup,
        hasActivitySinceBackup: backup.hasActivitySinceBackup,
      },
      audit: {
        ok: audit.ok,
        entryCount: audit.entries,
        firstError: audit.errors[0] ?? null,
      },
      recentActivity,
    };
  } finally {
    db.close();
  }
}

// --------------------------------------------------------------------------
// Per-company fiscal years
// --------------------------------------------------------------------------

/** One fiscal year available for a company. */
export type FiscalYearEntry = {
  /** Stable, sortable label for the year, e.g. "2026" or "2025-26". */
  label: string;
  /** Fiscal-year start date (YYYY-MM-DD); null for an archived year. */
  start: string | null;
  /** Fiscal-year end date (YYYY-MM-DD); null for an archived year. */
  end: string | null;
  /** Where the year's data lives: the live hash-chained ledger or the archive. */
  source: "live" | "archive";
};

export type CompanyFiscalYears = {
  slug: string;
  /** Fiscal years, descending by label — newest first. */
  years: FiscalYearEntry[];
};

/**
 * The fiscal years available for a company: the live ledger's year(s) — every
 * distinct fiscal year touched by a posted `journal_entries` row — plus any
 * read-only archived years from the `import_archive_years` table (#197).
 *
 * Years are deduplicated by label (a live year wins over an archived one of
 * the same label) and returned newest-first. Throws `ApiError.notFound` when
 * the slug is not registered or the ledger is missing on disk.
 */
export function buildCompanyFiscalYears(
  workspaceRoot: string,
  slug: string,
): CompanyFiscalYears {
  const entry = findWorkspaceCompany(workspaceRoot, slug);
  if (!entry) {
    throw ApiError.notFound(`no company with slug '${slug}' in the workspace`);
  }
  const companyRoot = companyRootForSlug(workspaceRoot, slug);
  const dbPath = companyPaths(companyRoot).db;
  if (!existsSync(dbPath)) {
    throw ApiError.notFound(`company '${slug}' has no ledger`);
  }

  const db = openDb(dbPath);
  try {
    migrate(db);
    const company = getCompanySettings(db);
    const byLabel = new Map<string, FiscalYearEntry>();

    // Live ledger: one fiscal year per distinct transaction_date, collapsed.
    const dateRows = db
      .query(
        "SELECT DISTINCT transaction_date AS d FROM journal_entries WHERE status = 'posted'",
      )
      .all() as Array<{ d: string }>;
    for (const row of dateRows) {
      if (!ISO_DATE_RE.test(row.d)) continue;
      const fy = fiscalYearForDate(
        row.d,
        company.fiscalYearStartMonth,
        company.fiscalYearLabelStrategy,
      );
      byLabel.set(fy.identifierLabel, {
        label: fy.identifierLabel,
        start: fy.start,
        end: fy.end,
        source: "live",
      });
    }

    // Archived years (#197) — read-only reference data, outside the ledger.
    const archiveRows = db
      .query(
        "SELECT DISTINCT fiscal_year AS y FROM import_archive_years ORDER BY fiscal_year",
      )
      .all() as Array<{ y: number }>;
    for (const row of archiveRows) {
      const label = String(row.y);
      // A live year of the same label is authoritative — never shadow it.
      if (byLabel.has(label)) continue;
      byLabel.set(label, { label, start: null, end: null, source: "archive" });
    }

    const years = [...byLabel.values()].sort((a, b) =>
      b.label.localeCompare(a.label),
    );
    return { slug: entry.slug, years };
  } finally {
    db.close();
  }
}
