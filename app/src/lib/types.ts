// Wire types — the JSON shapes returned by `rentemester serve` (#170).
//
// These mirror `src/server/data.ts` and `src/server/router.ts`. They are kept
// deliberately as a hand-written copy: the SPA is a separate package and does
// not import from the backend's TypeScript sources.

export type ApiErrorBody = {
  ok: false;
  error: { code: string; message: string };
};

export type HealthResponse = {
  ok: true;
  service: string;
  workspace: string;
  authRequired: boolean;
};

export type CompanyEntry = {
  slug: string;
  name: string;
  createdAt: string;
  archived: boolean;
};

export type CompanyListResponse = {
  ok: true;
  workspace: string;
  count: number;
  companies: CompanyEntry[];
};

export type CompanySummary = {
  slug: string;
  name: string;
  cvr: string | null;
  archived: boolean;
  ledgerMissing: boolean;
  openInvoiceCount: number;
  openInvoiceTotal: number;
  overdueInvoiceCount: number;
  unlinkedBankCount: number;
  openExceptionCount: number;
  netVatPayable: number;
  auditChainOk: boolean;
};

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

export type PortfolioResponse = {
  ok: true;
  portfolio: PortfolioOverview;
};

export type InvoiceRow = {
  invoiceNumber: string;
  customerName?: string;
  issueDate?: string;
  dueDate?: string;
  total?: number;
  openBalance: number;
  [key: string]: unknown;
};

export type ExceptionRow = {
  id: string | number;
  type: string;
  severity: string;
  status: string;
  message: string;
};

export type AuditLogRow = {
  occurredAt?: string;
  action?: string;
  summary?: string;
  [key: string]: unknown;
};

export type CompanyDashboard = {
  slug: string;
  asOf: string;
  company: {
    name: string;
    cvr: string | null;
    country: string;
    currency: string;
    fiscalYearStartMonth: number | string;
    fiscalYearLabelStrategy: string;
  };
  invoices: { count: number; openTotal: number; rows: InvoiceRow[] };
  overdueInvoices: { count: number; rows: InvoiceRow[] };
  unlinkedBank: { count: number };
  exceptions: { count: number; rows: ExceptionRow[] };
  vat: {
    periodStart: string;
    periodEnd: string;
    netVatPayable: number;
    daysRemaining: number;
    errors: unknown[];
  };
  backup: {
    backupsFound: boolean;
    latestBackupAt: string | null;
    daysSinceLatestBackup: number | null;
    hasActivitySinceBackup: boolean;
  };
  audit: { ok: boolean; entryCount: number; firstError: unknown };
  recentActivity: AuditLogRow[];
};

export type DashboardResponse = {
  ok: true;
  dashboard: CompanyDashboard;
};

// --- fiscal years (GET /api/companies/:slug/fiscal-years) -----------------

export type FiscalYearEntry = {
  label: string;
  start: string | null;
  end: string | null;
  source: "live" | "archive";
};

export type FiscalYearsResponse = {
  ok: true;
  fiscalYears: { slug: string; years: FiscalYearEntry[] };
};

// --- overview (GET /api/companies/:slug/overview?year=) -------------------

export type OverviewMonth = {
  month: number;
  label: string;
  income: number;
  expense: number;
};

export type OverviewExceptionRow = {
  id: number;
  type: string;
  severity: string;
  message: string;
};

export type OverviewRecentEntry = {
  id: number;
  entryNo: string;
  date: string;
  text: string;
  amount: number;
};

/**
 * The "Overblik" payload. All money fields are kroner (DKK with decimals) —
 * use `formatKroner`, not `formatCurrency` (which expects minor units).
 */
export type CompanyOverview = {
  slug: string;
  selectedYear: string;
  /** True for an archived-only year — the live ledger has nothing for it. */
  archived: boolean;
  company: {
    name: string;
    cvr: string | null;
    country: string;
    currency: string;
    fiscalYearStartMonth: number | string;
    fiscalYearLabelStrategy: string;
  };
  fiscalYears: FiscalYearEntry[];
  profitAndLoss: {
    omsaetning: number;
    udgifter: number;
    resultat: number;
    months: OverviewMonth[];
  };
  bank: { balance: number };
  vat: {
    periodStart: string;
    periodEnd: string;
    periodLabel: string;
    /** 25% of the standard-rated sales base for the period, kroner. */
    outputVat: number;
    /** 25% of the standard-rated purchase base for the period, kroner. */
    inputVat: number;
    /** outputVat − inputVat; positive is payable to SKAT, kroner. */
    payable: number;
  };
  exceptions: { count: number; rows: OverviewExceptionRow[] };
  recentEntries: OverviewRecentEntry[];
};

export type OverviewResponse = {
  ok: true;
  overview: CompanyOverview;
};

// --- financial statements (cockpit-redesign iteration 2) ------------------
//
// All money fields below are kroner (DKK with decimals) — use `formatKroner`.

/** The company identity block shared by every statement payload. */
export type StatementCompany = {
  name: string;
  cvr: string | null;
  country: string;
  currency: string;
  fiscalYearStartMonth: number | string;
  fiscalYearLabelStrategy: string;
};

// --- income statement (GET .../income-statement?year=) --------------------

export type IncomeStatementLine = {
  accountNo: string;
  name: string;
  amount: number;
  /** The same account's amount in the prior calendar year, kroner. */
  priorAmount: number;
};

export type CompanyIncomeStatement = {
  slug: string;
  selectedYear: string;
  archived: boolean;
  company: StatementCompany;
  fiscalYears: FiscalYearEntry[];
  income: IncomeStatementLine[];
  expense: IncomeStatementLine[];
  totalIncome: number;
  totalExpense: number;
  priorTotalIncome: number;
  priorTotalExpense: number;
  result: number;
  priorResult: number;
};

export type IncomeStatementResponse = {
  ok: true;
  incomeStatement: CompanyIncomeStatement;
};

// --- balance sheet (GET .../balance?year=) --------------------------------

export type BalanceLine = {
  accountNo: string;
  name: string;
  amount: number;
};

export type BalanceSection = {
  lines: BalanceLine[];
  total: number;
};

export type CompanyBalance = {
  slug: string;
  selectedYear: string;
  archived: boolean;
  company: StatementCompany;
  fiscalYears: FiscalYearEntry[];
  asOfDate: string;
  assets: BalanceSection;
  liabilities: BalanceSection;
  equity: BalanceSection;
  /** The un-closed period result, carried into the equity side. */
  periodResult: number;
  totalAssets: number;
  totalLiabilitiesAndEquity: number;
  balanced: boolean;
};

export type BalanceResponse = {
  ok: true;
  balance: CompanyBalance;
};

// --- trial balance (GET .../trial-balance?year=) --------------------------

export type TrialBalanceRow = {
  accountNo: string;
  name: string;
  type: string;
  debit: number;
  credit: number;
  balance: number;
};

export type CompanyTrialBalance = {
  slug: string;
  selectedYear: string;
  archived: boolean;
  company: StatementCompany;
  fiscalYears: FiscalYearEntry[];
  periodStart: string;
  periodEnd: string;
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
};

export type TrialBalanceResponse = {
  ok: true;
  trialBalance: CompanyTrialBalance;
};

export type CreateCompanyInput = {
  name: string;
  slug?: string;
  cvr?: string;
  fiscalYearStartMonth?: string;
  fiscalYearLabelStrategy?: string;
};

export type UpdateCompanyInput = {
  name?: string;
  archived?: boolean;
};
