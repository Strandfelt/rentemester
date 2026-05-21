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

/**
 * One grouped exception line for the "Opgaver" card — every open exception of
 * one `type` collapsed into a single Danish, actionable summary line.
 */
export type OverviewExceptionGroup = {
  type: string;
  count: number;
  severity: "low" | "medium" | "high";
  /** Danish one-liner, e.g. "362 banktransaktioner mangler afstemning". */
  label: string;
  /** The cockpit sub-view this group links to (e.g. "bank"); null when none. */
  link: string | null;
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
  bank: {
    /** Booked ledger balance of the bank/cash accounts at the year end, kroner. */
    balance: number;
    /** Actual statement balance (latest imported `balance_after`), kroner; null when unknown. */
    actualBalance: number | null;
    /** balance − actualBalance; the unreconciled gap, kroner; null when unknown. */
    difference: number | null;
  };
  /** Money owed TO the company — open issued-invoice balances at year end. */
  receivables: {
    /** Number of issued invoices still carrying an open balance. */
    openCount: number;
    /** Sum of the open balances, kroner. */
    openTotal: number;
  };
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
    /** The statutory VAT filing/payment deadline, YYYY-MM-DD. */
    deadline: string;
    /** Signed countdown from today to the deadline; negative once passed. */
    daysRemaining: number;
  };
  exceptions: {
    count: number;
    rows: OverviewExceptionRow[];
    groups: OverviewExceptionGroup[];
  };
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

// --- journal / Posteringer (GET .../journal?year=) ------------------------
//
// All money fields below are kroner (DKK with decimals) — use `formatKroner`.

export type JournalLine = {
  accountNo: string;
  accountName: string;
  debit: number;
  credit: number;
  text: string | null;
};

export type JournalEntry = {
  id: number;
  entryNo: string;
  date: string;
  text: string;
  /** Sum of the debit side — the entry total, kroner. */
  total: number;
  lines: JournalLine[];
};

export type CompanyJournal = {
  slug: string;
  selectedYear: string;
  archived: boolean;
  company: StatementCompany;
  fiscalYears: FiscalYearEntry[];
  periodStart: string;
  periodEnd: string;
  entries: JournalEntry[];
};

export type JournalResponse = {
  ok: true;
  journal: CompanyJournal;
};

// --- bank / Bank (GET .../bank?year=) -------------------------------------

export type BankAccountInfo = {
  id: number;
  name: string;
  bankName: string | null;
  accountNo: string | null;
  ledgerAccountNo: string | null;
};

export type BankTransactionRow = {
  id: number;
  date: string;
  text: string;
  amount: number;
  /** Running balance from the import, kroner; null when the export omits it. */
  runningBalance: number | null;
  reconciliationStatus: "matched" | "unmatched";
  journalEntryNo: string | null;
};

export type CompanyBank = {
  slug: string;
  selectedYear: string;
  archived: boolean;
  company: StatementCompany;
  fiscalYears: FiscalYearEntry[];
  periodStart: string;
  periodEnd: string;
  accounts: BankAccountInfo[];
  /** Booked ledger balance of the bank/cash accounts at the year end, kroner. */
  bookedBalance: number;
  /** Actual statement balance (latest imported `balance_after`), kroner; null when unknown. */
  actualBalance: number | null;
  /** bookedBalance − actualBalance; the unreconciled gap, kroner; null when unknown. */
  difference: number | null;
  transactions: BankTransactionRow[];
  matchedCount: number;
  unmatchedCount: number;
};

export type BankResponse = {
  ok: true;
  bank: CompanyBank;
};

// --- VAT / Moms (GET .../vat?year=) ---------------------------------------

export type CompanyVat = {
  slug: string;
  selectedYear: string;
  archived: boolean;
  company: StatementCompany;
  fiscalYears: FiscalYearEntry[];
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  /** Output VAT (salgsmoms) booked for the period, kroner. */
  outputVat: number;
  /** Input VAT (købsmoms) booked for the period, kroner. */
  inputVat: number;
  /** outputVat − inputVat; positive is payable to SKAT, kroner. */
  payable: number;
  /** The statutory VAT filing/payment deadline, YYYY-MM-DD. */
  deadline: string;
  /** Signed countdown from today to the deadline; negative once passed. */
  daysRemaining: number;
};

export type VatResponse = {
  ok: true;
  vat: CompanyVat;
};

// --- documents / Bilag (GET .../documents) --------------------------------

export type DocumentRow = {
  id: number;
  documentNo: string | null;
  source: string;
  filename: string | null;
  documentType: string;
  supplierName: string | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  amountIncVat: number | null;
  currency: string;
  status: string;
  voucherRef: string | null;
  journalEntryNo: string | null;
  journalEntryId: number | null;
};

export type CompanyDocuments = {
  slug: string;
  company: StatementCompany;
  documents: DocumentRow[];
  linkedCount: number;
  unlinkedCount: number;
};

export type DocumentsResponse = {
  ok: true;
  documents: CompanyDocuments;
};

// --- archive / Arkiv (GET .../archive/:year) — cockpit-redesign it. 4 -------
//
// All money fields below are kroner (DKK with decimals) — use `formatKroner`.

export type ArchiveBalanceRow = {
  accountNo: string;
  name: string;
  /** Closing balance, kroner, exactly as the Dinero export stored it. */
  amount: number;
};

export type CompanyArchiveYear = {
  slug: string;
  company: StatementCompany;
  /** The archived fiscal-year label, e.g. "2025". */
  year: string;
  /** The accounting system the archive was exported from, e.g. "dinero". */
  sourceSystem: string;
  importedAt: string;
  /** The year's full SaldoBalance — every account's closing balance. */
  saldoBalance: ArchiveBalanceRow[];
  /** A summary of the archived Posteringer for the year. */
  postings: {
    count: number;
    /** Sum of the absolute posting amounts — the gross volume, kroner. */
    grossTotal: number;
  };
};

export type ArchiveResponse = {
  ok: true;
  archive: CompanyArchiveYear;
};

// --- multi-year / Flerårsoversigt (GET .../multi-year) — it. 4 --------------

export type MultiYearRow = {
  /** The fiscal-year label, e.g. "2025". */
  year: string;
  source: "live" | "archive";
  /** Income / omsætning for the year, kroner. */
  omsaetning: number;
  /** Expenses / udgifter for the year, kroner. */
  udgifter: number;
  /** Result (omsætning − udgifter), kroner. */
  resultat: number;
};

export type CompanyMultiYear = {
  slug: string;
  company: StatementCompany;
  /** Key figures per fiscal year, oldest→newest for charting a trend. */
  years: MultiYearRow[];
};

export type MultiYearResponse = {
  ok: true;
  multiYear: CompanyMultiYear;
};

// --- invoices / Fakturaer (GET .../invoices?year=) — cockpit-redesign it. 5 --
//
// All money fields below are kroner (DKK with decimals) — use `formatKroner`.

export type InvoiceStatus =
  | "open"
  | "paid"
  | "credited"
  | "refunded"
  | "overpaid"
  | "written_off"
  | "overdue";

export type CompanyInvoiceRow = {
  documentId: number;
  invoiceNo: string;
  invoiceDate: string | null;
  customerName: string | null;
  /** Gross amount inc. VAT, kroner. */
  grossAmount: number;
  /** Still-outstanding balance on the invoice, kroner. */
  openBalance: number;
  currency: string;
  status: InvoiceStatus;
  effectiveDueDate: string | null;
  overdueDays: number;
};

export type CompanyInvoices = {
  slug: string;
  selectedYear: string;
  archived: boolean;
  company: StatementCompany;
  fiscalYears: FiscalYearEntry[];
  periodStart: string;
  periodEnd: string;
  invoices: CompanyInvoiceRow[];
  totalGross: number;
  totalOpen: number;
  overdueCount: number;
};

export type InvoicesResponse = {
  ok: true;
  invoices: CompanyInvoices;
};

// --- contacts / Kontakter (GET .../contacts) — cockpit-redesign it. 5 --------

export type ContactCustomerRow = {
  id: number;
  name: string;
  vatOrCvr: string | null;
  email: string | null;
  paymentTermsDays: number;
  defaultCurrency: string;
};

export type ContactVendorRow = {
  id: number;
  name: string;
  vatOrCvr: string | null;
  defaultExpenseAccount: string | null;
  defaultVatTreatment: string | null;
};

export type CompanyContacts = {
  slug: string;
  company: StatementCompany;
  fiscalYears: FiscalYearEntry[];
  customers: ContactCustomerRow[];
  vendors: ContactVendorRow[];
};

export type ContactsResponse = {
  ok: true;
  contacts: CompanyContacts;
};

// --- obligations / Forpligtelser (GET .../obligations?year=) — it. 7 --------
//
// All money fields below are kroner (DKK with decimals) — use `formatKroner`.

export type ObligationKind =
  | "vat"
  | "corporation-tax"
  | "creditors"
  | "auditor"
  | "other";

export type ObligationRow = {
  kind: ObligationKind;
  /** A human Danish label, e.g. "Moms — 1. halvår 2026". */
  label: string;
  /** The amount owed, kroner; positive is payable. */
  amount: number;
  /** The filing/payment deadline as YYYY-MM-DD, or null when none is known. */
  dueDate: string | null;
  /** Signed countdown from today to `dueDate`; null when `dueDate` is null. */
  daysRemaining: number | null;
  /** The ledger account the figure was read from, when one applies. */
  accountNo: string | null;
};

export type CompanyObligations = {
  slug: string;
  selectedYear: string;
  archived: boolean;
  company: StatementCompany;
  fiscalYears: FiscalYearEntry[];
  /** Payables sorted by due date, soonest first; dateless rows last. */
  obligations: ObligationRow[];
  /** Sum of every obligation's amount, kroner. */
  totalOwed: number;
};

export type ObligationsResponse = {
  ok: true;
  obligations: CompanyObligations;
};

// --- cash flow / Likviditet (GET .../cashflow?year=) ----------------------

export type CashflowMonth = {
  /** 1–12. */
  month: number;
  label: string;
  /** Money in: sum of positive bank-transaction amounts, kroner. */
  indbetalinger: number;
  /** Money out: sum of negative amounts as a positive figure, kroner. */
  udbetalinger: number;
  /** indbetalinger − udbetalinger, kroner. */
  netto: number;
};

export type CashflowBalancePoint = {
  date: string;
  /** The imported running balance at this point, kroner. */
  balance: number;
};

export type CompanyCashflow = {
  slug: string;
  selectedYear: string;
  archived: boolean;
  company: StatementCompany;
  fiscalYears: FiscalYearEntry[];
  periodStart: string;
  periodEnd: string;
  /** False when the company has no bank transactions in the year. */
  hasTransactions: boolean;
  months: CashflowMonth[];
  /** The real bank-balance trajectory, oldest-first. */
  balanceSeries: CashflowBalancePoint[];
  /** Actual balance the day before the year starts, kroner; null when unknown. */
  openingBalance: number | null;
  /** Actual balance at the year end, kroner; null when unknown. */
  closingBalance: number | null;
  /** Total money in across the year, kroner. */
  totalIn: number;
  /** Total money out across the year, kroner. */
  totalOut: number;
};

export type CashflowResponse = {
  ok: true;
  cashflow: CompanyCashflow;
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
