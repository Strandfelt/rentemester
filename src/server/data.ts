// Read-side data assembly for the cockpit backend (#170).
//
// Every figure here is computed by an existing core function — this module
// only opens the right ledger, calls core, and shapes the JSON. No business
// logic is duplicated and nothing here mutates a ledger.

import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { companyPaths } from "../core/paths";
import { openDb, migrate } from "../core/db";
import { getCompanySettings } from "../core/company";
import { fiscalYearForDate } from "../core/fiscal-year";
import { buildInvoiceList, buildOverdueInvoiceList } from "../core/invoice-list";
import { listBankTransactions } from "../core/reconciliation";
import { listExceptions } from "../core/exceptions";
import { buildVatReport } from "../core/vat";
import {
  buildBalanceSheet,
  buildProfitAndLoss,
  buildTrialBalance,
} from "../core/financial-statements";
import { listBankAccounts } from "../core/bank";
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

// --------------------------------------------------------------------------
// Per-company overview (the "Overblik" dashboard, year-aware)
// --------------------------------------------------------------------------

const YEAR_RE = /^\d{4}$/;

/**
 * Validates an optional `?year=` query value. Returns null when absent so the
 * caller can default to the company's most recent live fiscal year.
 */
export function resolveYearParam(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.length === 0) return null;
  if (!YEAR_RE.test(raw)) {
    throw ApiError.badRequest("year must be a four-digit calendar year");
  }
  return parseInt(raw, 10);
}

/** The two ISO dates [start, end] for a half of the calendar year `year`. */
function halfYearPeriod(year: number, half: 1 | 2): { start: string; end: string } {
  return half === 1
    ? { start: `${year}-01-01`, end: `${year}-06-30` }
    : { start: `${year}-07-01`, end: `${year}-12-31` };
}

/** Rounds a kroner amount to whole øre, killing float drift. */
function roundKroner(value: number): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

export type VatPosition = {
  periodStart: string;
  periodEnd: string;
  /** Output VAT (salgsmoms) booked for the period, kroner. */
  outputVat: number;
  /** Input VAT (købsmoms) booked for the period, kroner. */
  inputVat: number;
  /** outputVat − inputVat; positive is payable to SKAT, kroner. */
  payable: number;
};

/**
 * The VAT position for a period, computed from the VAT *amounts booked on the
 * VAT accounts themselves* — the truthful obligation regardless of how the
 * chart of accounts numbers them.
 *
 * A VAT account is any account that is `type = 'vat'` (the native-Rentemester
 * chart: `1200` Salgsmoms, `4000` Købsmoms) OR sits in the standard Danish VAT
 * block `64000`–`64099` (a Dinero-imported chart, where the VAT accounts are
 * typed `liability`). The `64100` settlement account is excluded — it only
 * moves money between the VAT accounts and the bank and is not itself an
 * obligation.
 *
 * Output VAT is the credit-signed movement of output-side VAT accounts; input
 * VAT the credit-signed movement of input-side ones. An account is input-side
 * when it is debit-normal (the native-Rentemester `4000` Købsmoms) or carries
 * a standard Danish input-VAT account number (`64060` Købsmoms; `64080`/
 * `64085`/`64090` afgift-reclaim). The net payable is output − input —
 * arithmetically the credit-signed net of every VAT account, so it is correct
 * regardless of how cleanly the input/output split lands. Money is kroner.
 */
const INPUT_VAT_ACCOUNT_NOS = new Set(["64060", "64080", "64085", "64090"]);

function vatPositionForPeriod(
  db: Database,
  periodStart: string,
  periodEnd: string,
): VatPosition {
  const rows = db
    .query(
      `SELECT a.account_no     AS accountNo,
              a.normal_balance AS normalBalance,
              jl.debit_amount  AS debit,
              jl.credit_amount AS credit
         FROM journal_entries je
         JOIN journal_lines jl ON jl.journal_entry_id = je.id
         JOIN accounts a       ON a.id = jl.account_id
        WHERE je.status = 'posted'
          AND je.transaction_date >= ? AND je.transaction_date <= ?
          AND (a.type = 'vat'
               OR (a.account_no >= '64000' AND a.account_no < '64100'))`,
    )
    .all(periodStart, periodEnd) as Array<{
    accountNo: string;
    normalBalance: "debit" | "credit";
    debit: number;
    credit: number;
  }>;

  let outputVat = 0;
  let inputVat = 0;
  for (const row of rows) {
    const debit = Number(row.debit ?? 0);
    const credit = Number(row.credit ?? 0);
    const isInput =
      row.normalBalance === "debit" || INPUT_VAT_ACCOUNT_NOS.has(row.accountNo);
    if (isInput) {
      inputVat += debit - credit;
    } else {
      outputVat += credit - debit;
    }
  }

  outputVat = roundKroner(outputVat);
  inputVat = roundKroner(inputVat);
  return {
    periodStart,
    periodEnd,
    outputVat,
    inputVat,
    payable: roundKroner(outputVat - inputVat),
  };
}

/**
 * Booked balance of the bank / cash asset accounts at `asOfDate`, kroner.
 *
 * Bank accounts are identified by the `bank_accounts.ledger_account_no` link
 * when any bank account is registered; otherwise it falls back to every
 * `asset`-type account whose name reads as a bank or cash account. This keeps
 * the figure independent of any one chart's account numbering.
 */
function bankBalanceAsOf(db: Database, asOfDate: string): number {
  const linked = listBankAccounts(db)
    .accounts.map((a) => a.ledgerAccountNo)
    .filter((no): no is string => typeof no === "string" && no.length > 0);

  let accountNos: string[];
  if (linked.length > 0) {
    accountNos = [...new Set(linked)];
  } else {
    accountNos = (
      db
        .query(
          `SELECT account_no FROM accounts
            WHERE type = 'asset'
              AND (lower(name) LIKE '%bank%' OR lower(name) LIKE '%kasse%'
                   OR lower(name) LIKE '%giro%')`,
        )
        .all() as Array<{ account_no: string }>
    ).map((r) => r.account_no);
  }
  if (accountNos.length === 0) return 0;

  const placeholders = accountNos.map(() => "?").join(", ");
  const row = db
    .query(
      `SELECT COALESCE(SUM(jl.debit_amount - jl.credit_amount), 0) AS bal
         FROM journal_entries je
         JOIN journal_lines jl ON jl.journal_entry_id = je.id
         JOIN accounts a       ON a.id = jl.account_id
        WHERE je.status = 'posted'
          AND je.transaction_date <= ?
          AND a.account_no IN (${placeholders})`,
    )
    .get(asOfDate, ...accountNos) as { bal: number };
  return roundKroner(row.bal);
}

const MONTH_NAMES_DK = [
  "jan", "feb", "mar", "apr", "maj", "jun",
  "jul", "aug", "sep", "okt", "nov", "dec",
];

export type OverviewMonth = {
  /** 1–12. */
  month: number;
  label: string;
  income: number;
  expense: number;
};

export type CompanyOverview = ReturnType<typeof buildCompanyOverview>;

/**
 * Per-company "Overblik" — the year-aware company dashboard the cockpit SPA's
 * P0 view renders. Every figure is computed from posted ledger postings: the
 * P&L from `core/financial-statements`, the VAT position from the booked VAT
 * accounts, the bank balance from the cash asset accounts. Money is kroner.
 *
 * `year` selects the calendar fiscal year; when omitted the company's most
 * recent live year is used. An archived-only year returns `archived: true`
 * with empty figures — the live ledger has nothing for it (#197 archive data
 * is surfaced in a later iteration).
 *
 * Throws `ApiError.notFound` when the slug is not registered or has no ledger.
 */
export function buildCompanyOverview(
  workspaceRoot: string,
  slug: string,
  year: number | null,
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

  const fiscalYears = buildCompanyFiscalYears(workspaceRoot, slug);
  const years = fiscalYears.years;
  // Default to the most recent live year, falling back to the newest year.
  const liveYears = years.filter((y) => y.source === "live");
  const defaultYear =
    liveYears[0]?.label ?? years[0]?.label ?? String(new Date().getUTCFullYear());
  const selectedLabel = year !== null ? String(year) : defaultYear;
  const selected = years.find((y) => y.label === selectedLabel);
  const isArchivedOnly = selected ? selected.source === "archive" : false;

  const db = openDb(dbPath);
  try {
    migrate(db);
    const company = getCompanySettings(db);

    const companyBlock = {
      name: company.name,
      cvr: company.cvr,
      country: company.country,
      currency: company.currency,
      fiscalYearStartMonth: company.fiscalYearStartMonth,
      fiscalYearLabelStrategy: company.fiscalYearLabelStrategy,
    };

    // An archived-only year has no live-ledger data — surface a clear marker
    // so the SPA can render the "se Arkiv" state without inventing figures.
    if (isArchivedOnly) {
      return {
        slug: entry.slug,
        selectedYear: selectedLabel,
        archived: true,
        company: companyBlock,
        fiscalYears: years,
        profitAndLoss: {
          omsaetning: 0,
          udgifter: 0,
          resultat: 0,
          months: [] as OverviewMonth[],
        },
        bank: { balance: 0 },
        vat: {
          periodStart: `${selectedLabel}-01-01`,
          periodEnd: `${selectedLabel}-06-30`,
          periodLabel: `1. halvår ${selectedLabel}`,
          outputVat: 0,
          inputVat: 0,
          payable: 0,
        },
        exceptions: { count: 0, rows: [] as ExceptionPreview[] },
        recentEntries: [] as RecentEntry[],
      };
    }

    const yearNum = parseInt(selectedLabel, 10);
    const yearStart = `${yearNum}-01-01`;
    const yearEnd = `${yearNum}-12-31`;

    // P&L for the full year, reusing the core financial statement.
    const pl = buildProfitAndLoss(db, yearStart, yearEnd);

    // Monthly breakdown — one income/expense pair per calendar month.
    const months: OverviewMonth[] = [];
    for (let m = 1; m <= 12; m += 1) {
      const mm = String(m).padStart(2, "0");
      const last = new Date(Date.UTC(yearNum, m, 0)).getUTCDate();
      const mPl = buildProfitAndLoss(
        db,
        `${yearNum}-${mm}-01`,
        `${yearNum}-${mm}-${String(last).padStart(2, "0")}`,
      );
      months.push({
        month: m,
        label: MONTH_NAMES_DK[m - 1]!,
        income: mPl.totalIncome,
        expense: mPl.totalExpense,
      });
    }

    // VAT position: each half-year settles separately. Surface the first half
    // by default, switching to the second only when the first is empty and
    // the second carries activity.
    const p1 = halfYearPeriod(yearNum, 1);
    const p2 = halfYearPeriod(yearNum, 2);
    const h1 = vatPositionForPeriod(db, p1.start, p1.end);
    const h2 = vatPositionForPeriod(db, p2.start, p2.end);
    const useSecondHalf = h1.payable === 0 && h2.payable !== 0;
    const vat = useSecondHalf ? h2 : h1;
    const vatHalf: 1 | 2 = useSecondHalf ? 2 : 1;

    // The exception queue.
    const exceptions = listExceptions(db, { status: "open" });
    const exceptionRows: ExceptionPreview[] = exceptions.rows
      .slice(0, 6)
      .map((row: any) => ({
        id: row.id,
        type: row.type,
        severity: row.severity,
        message: row.message,
      }));

    // The most recent posted journal entries within the selected year.
    const entryRows = db
      .query(
        `SELECT je.id          AS id,
                je.entry_no    AS entryNo,
                je.transaction_date AS date,
                je.text        AS text,
                (SELECT COALESCE(SUM(debit_amount), 0)
                   FROM journal_lines WHERE journal_entry_id = je.id) AS amount
           FROM journal_entries je
          WHERE je.status = 'posted'
            AND je.transaction_date >= ? AND je.transaction_date <= ?
          ORDER BY je.transaction_date DESC, je.id DESC
          LIMIT 8`,
      )
      .all(yearStart, yearEnd) as Array<{
      id: number;
      entryNo: string;
      date: string;
      text: string;
      amount: number;
    }>;
    const recentEntries: RecentEntry[] = entryRows.map((r) => ({
      id: r.id,
      entryNo: r.entryNo,
      date: r.date,
      text: r.text,
      amount: Math.round(Number(r.amount ?? 0) * 100) / 100,
    }));

    return {
      slug: entry.slug,
      selectedYear: selectedLabel,
      archived: false,
      company: companyBlock,
      fiscalYears: years,
      profitAndLoss: {
        omsaetning: pl.totalIncome,
        udgifter: pl.totalExpense,
        resultat: pl.result,
        months,
      },
      bank: { balance: bankBalanceAsOf(db, yearEnd) },
      vat: {
        periodStart: vat.periodStart,
        periodEnd: vat.periodEnd,
        periodLabel: `${vatHalf}. halvår ${yearNum}`,
        outputVat: vat.outputVat,
        inputVat: vat.inputVat,
        payable: vat.payable,
      },
      exceptions: { count: exceptions.count, rows: exceptionRows },
      recentEntries,
    };
  } finally {
    db.close();
  }
}

type ExceptionPreview = {
  id: number;
  type: string;
  severity: string;
  message: string;
};

type RecentEntry = {
  id: number;
  entryNo: string;
  date: string;
  text: string;
  amount: number;
};

// --------------------------------------------------------------------------
// Per-company financial statements (year-aware) — cockpit-redesign it. 2
// --------------------------------------------------------------------------

/**
 * Resolves the company, opens its ledger and picks the selected fiscal year —
 * the shared preamble for the statement builders below. The selected year
 * follows `buildCompanyOverview`: an explicit `?year=` wins, else the most
 * recent live year, else the newest available year.
 *
 * Throws `ApiError.notFound` when the slug is not registered or has no ledger.
 */
function resolveStatementContext(
  workspaceRoot: string,
  slug: string,
  year: number | null,
): {
  entry: WorkspaceCompanyEntry;
  db: Database;
  company: ReturnType<typeof getCompanySettings>;
  years: FiscalYearEntry[];
  selectedLabel: string;
  isArchivedOnly: boolean;
} {
  const entry = findWorkspaceCompany(workspaceRoot, slug);
  if (!entry) {
    throw ApiError.notFound(`no company with slug '${slug}' in the workspace`);
  }
  const companyRoot = companyRootForSlug(workspaceRoot, slug);
  const dbPath = companyPaths(companyRoot).db;
  if (!existsSync(dbPath)) {
    throw ApiError.notFound(`company '${slug}' has no ledger`);
  }

  const years = buildCompanyFiscalYears(workspaceRoot, slug).years;
  const liveYears = years.filter((y) => y.source === "live");
  const defaultYear =
    liveYears[0]?.label ?? years[0]?.label ?? String(new Date().getUTCFullYear());
  const selectedLabel = year !== null ? String(year) : defaultYear;
  const selected = years.find((y) => y.label === selectedLabel);
  const isArchivedOnly = selected ? selected.source === "archive" : false;

  const db = openDb(dbPath);
  migrate(db);
  return {
    entry,
    db,
    company: getCompanySettings(db),
    years,
    selectedLabel,
    isArchivedOnly,
  };
}

export type StatementCompanyBlock = {
  name: string;
  cvr: string | null;
  country: string;
  currency: string;
  fiscalYearStartMonth: number | string;
  fiscalYearLabelStrategy: string;
};

function statementCompanyBlock(
  company: ReturnType<typeof getCompanySettings>,
): StatementCompanyBlock {
  return {
    name: company.name,
    cvr: company.cvr,
    country: company.country,
    currency: company.currency,
    fiscalYearStartMonth: company.fiscalYearStartMonth,
    fiscalYearLabelStrategy: company.fiscalYearLabelStrategy,
  };
}

export type IncomeStatementLine = {
  accountNo: string;
  name: string;
  amount: number;
  /** The same account's amount in the prior calendar year, kroner. */
  priorAmount: number;
};

export type CompanyIncomeStatement = ReturnType<typeof buildCompanyIncomeStatement>;

/**
 * Resultatopgørelse — the income statement for the selected calendar fiscal
 * year: income accounts and expense accounts, each with its own amount and the
 * prior year's amount for comparison, plus the totals and the result. Every
 * figure is computed by `core/financial-statements`. Money is kroner.
 */
export function buildCompanyIncomeStatement(
  workspaceRoot: string,
  slug: string,
  year: number | null,
) {
  const ctx = resolveStatementContext(workspaceRoot, slug, year);
  try {
    const companyBlock = statementCompanyBlock(ctx.company);
    if (ctx.isArchivedOnly) {
      return {
        slug: ctx.entry.slug,
        selectedYear: ctx.selectedLabel,
        archived: true,
        company: companyBlock,
        fiscalYears: ctx.years,
        income: [] as IncomeStatementLine[],
        expense: [] as IncomeStatementLine[],
        totalIncome: 0,
        totalExpense: 0,
        priorTotalIncome: 0,
        priorTotalExpense: 0,
        result: 0,
        priorResult: 0,
      };
    }

    const yearNum = parseInt(ctx.selectedLabel, 10);
    const current = buildProfitAndLoss(ctx.db, `${yearNum}-01-01`, `${yearNum}-12-31`);
    const prior = buildProfitAndLoss(
      ctx.db,
      `${yearNum - 1}-01-01`,
      `${yearNum - 1}-12-31`,
    );
    const priorIncome = new Map(prior.income.map((l) => [l.accountNo, l.amount]));
    const priorExpense = new Map(prior.expense.map((l) => [l.accountNo, l.amount]));

    const income: IncomeStatementLine[] = current.income.map((l) => ({
      accountNo: l.accountNo,
      name: l.name,
      amount: l.amount,
      priorAmount: priorIncome.get(l.accountNo) ?? 0,
    }));
    const expense: IncomeStatementLine[] = current.expense.map((l) => ({
      accountNo: l.accountNo,
      name: l.name,
      amount: l.amount,
      priorAmount: priorExpense.get(l.accountNo) ?? 0,
    }));

    return {
      slug: ctx.entry.slug,
      selectedYear: ctx.selectedLabel,
      archived: false,
      company: companyBlock,
      fiscalYears: ctx.years,
      income,
      expense,
      totalIncome: current.totalIncome,
      totalExpense: current.totalExpense,
      priorTotalIncome: prior.totalIncome,
      priorTotalExpense: prior.totalExpense,
      result: current.result,
      priorResult: prior.result,
    };
  } finally {
    ctx.db.close();
  }
}

export type BalanceLine = {
  accountNo: string;
  name: string;
  amount: number;
};

export type BalanceSection = {
  lines: BalanceLine[];
  total: number;
};

export type CompanyBalance = ReturnType<typeof buildCompanyBalance>;

/**
 * Balance — the balance sheet as of the selected fiscal year's end date:
 * assets, liabilities and equity sections with section totals. The un-closed
 * period result is surfaced under equity so the sheet balances (assets =
 * liabilities + equity). Computed by `core/financial-statements`. Money kroner.
 */
export function buildCompanyBalance(
  workspaceRoot: string,
  slug: string,
  year: number | null,
) {
  const ctx = resolveStatementContext(workspaceRoot, slug, year);
  try {
    const companyBlock = statementCompanyBlock(ctx.company);
    if (ctx.isArchivedOnly) {
      const empty: BalanceSection = { lines: [], total: 0 };
      return {
        slug: ctx.entry.slug,
        selectedYear: ctx.selectedLabel,
        archived: true,
        company: companyBlock,
        fiscalYears: ctx.years,
        asOfDate: `${ctx.selectedLabel}-12-31`,
        assets: empty,
        liabilities: empty,
        equity: empty,
        periodResult: 0,
        totalAssets: 0,
        totalLiabilitiesAndEquity: 0,
        balanced: true,
      };
    }

    const yearNum = parseInt(ctx.selectedLabel, 10);
    const asOfDate = `${yearNum}-12-31`;
    const bs = buildBalanceSheet(ctx.db, asOfDate);
    const toLines = (lines: { accountNo: string; name: string; amount: number }[]) =>
      lines.map((l) => ({ accountNo: l.accountNo, name: l.name, amount: l.amount }));

    return {
      slug: ctx.entry.slug,
      selectedYear: ctx.selectedLabel,
      archived: false,
      company: companyBlock,
      fiscalYears: ctx.years,
      asOfDate: bs.asOfDate,
      assets: { lines: toLines(bs.assets.lines), total: bs.assets.total },
      liabilities: {
        lines: toLines(bs.liabilities.lines),
        total: bs.liabilities.total,
      },
      equity: { lines: toLines(bs.equity.lines), total: bs.equity.total },
      periodResult: bs.periodResult,
      totalAssets: bs.totalAssets,
      totalLiabilitiesAndEquity: bs.totalLiabilitiesAndEquity,
      balanced: bs.balanced,
    };
  } finally {
    ctx.db.close();
  }
}

export type TrialBalanceRow = {
  accountNo: string;
  name: string;
  type: string;
  debit: number;
  credit: number;
  balance: number;
};

export type CompanyTrialBalance = ReturnType<typeof buildCompanyTrialBalance>;

/**
 * Saldobalance — the trial balance for the selected calendar fiscal year:
 * every account that moved, with its summed debit total, credit total and the
 * signed net balance. The report is balanced when total debit equals total
 * credit. Computed by `core/financial-statements`. Money is kroner.
 */
export function buildCompanyTrialBalance(
  workspaceRoot: string,
  slug: string,
  year: number | null,
) {
  const ctx = resolveStatementContext(workspaceRoot, slug, year);
  try {
    const companyBlock = statementCompanyBlock(ctx.company);
    if (ctx.isArchivedOnly) {
      return {
        slug: ctx.entry.slug,
        selectedYear: ctx.selectedLabel,
        archived: true,
        company: companyBlock,
        fiscalYears: ctx.years,
        periodStart: `${ctx.selectedLabel}-01-01`,
        periodEnd: `${ctx.selectedLabel}-12-31`,
        rows: [] as TrialBalanceRow[],
        totalDebit: 0,
        totalCredit: 0,
        balanced: true,
      };
    }

    const yearNum = parseInt(ctx.selectedLabel, 10);
    const tb = buildTrialBalance(ctx.db, `${yearNum}-01-01`, `${yearNum}-12-31`);
    const rows: TrialBalanceRow[] = tb.accounts.map((a) => ({
      accountNo: a.accountNo,
      name: a.name,
      type: a.type,
      debit: a.debit,
      credit: a.credit,
      balance: a.balance,
    }));

    return {
      slug: ctx.entry.slug,
      selectedYear: ctx.selectedLabel,
      archived: false,
      company: companyBlock,
      fiscalYears: ctx.years,
      periodStart: tb.periodStart,
      periodEnd: tb.periodEnd,
      rows,
      totalDebit: tb.totalDebit,
      totalCredit: tb.totalCredit,
      balanced: tb.balanced,
    };
  } finally {
    ctx.db.close();
  }
}
