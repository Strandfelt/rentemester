// Test fixtures + a fetch mock that speaks the cockpit API's JSON envelope.

import { vi } from "vitest";
import type {
  CompanyArchiveYear,
  CompanyBalance,
  CompanyBank,
  CompanyContacts,
  CompanyDashboard,
  CompanyDocuments,
  CompanyIncomeStatement,
  CompanyInvoices,
  CompanyJournal,
  CompanyMultiYear,
  CompanyOverview,
  CompanySummary,
  CompanyTrialBalance,
  CompanyVat,
  FiscalYearEntry,
} from "../lib/types";

export function summary(over: Partial<CompanySummary> = {}): CompanySummary {
  return {
    slug: "acme-aps",
    name: "Acme ApS",
    cvr: "DK12345678",
    archived: false,
    ledgerMissing: false,
    openInvoiceCount: 0,
    openInvoiceTotal: 0,
    overdueInvoiceCount: 0,
    unlinkedBankCount: 0,
    openExceptionCount: 0,
    netVatPayable: 0,
    auditChainOk: true,
    ...over,
  };
}

export function dashboard(over: Partial<CompanyDashboard> = {}): CompanyDashboard {
  return {
    slug: "acme-aps",
    asOf: "2026-05-20",
    company: {
      name: "Acme ApS",
      cvr: "DK12345678",
      country: "DK",
      currency: "DKK",
      fiscalYearStartMonth: 1,
      fiscalYearLabelStrategy: "calendar",
    },
    invoices: { count: 0, openTotal: 0, rows: [] },
    overdueInvoices: { count: 0, rows: [] },
    unlinkedBank: { count: 0 },
    exceptions: { count: 0, rows: [] },
    vat: {
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      netVatPayable: 0,
      daysRemaining: 41,
      errors: [],
    },
    backup: {
      backupsFound: true,
      latestBackupAt: "2026-05-19T00:00:00.000Z",
      daysSinceLatestBackup: 1,
      hasActivitySinceBackup: false,
    },
    audit: { ok: true, entryCount: 3, firstError: null },
    recentActivity: [],
    ...over,
  };
}

const MONTHS = [
  "jan", "feb", "mar", "apr", "maj", "jun",
  "jul", "aug", "sep", "okt", "nov", "dec",
];

export function overview(over: Partial<CompanyOverview> = {}): CompanyOverview {
  return {
    slug: "acme-aps",
    selectedYear: "2026",
    archived: false,
    company: {
      name: "Acme ApS",
      cvr: "DK12345678",
      country: "DK",
      currency: "DKK",
      fiscalYearStartMonth: 1,
      fiscalYearLabelStrategy: "end-year",
    },
    fiscalYears: [
      { label: "2026", start: "2026-01-01", end: "2026-12-31", source: "live" },
      { label: "2025", start: null, end: null, source: "archive" },
    ],
    profitAndLoss: {
      omsaetning: 17829.02,
      udgifter: 4594.2,
      resultat: 13234.82,
      months: MONTHS.map((label, i) => ({
        month: i + 1,
        label,
        income: i === 0 ? 17829.02 : 0,
        expense: i === 0 ? 4563.04 : 0,
      })),
    },
    bank: { balance: 41388.03, actualBalance: 23654.75, difference: 17733.28 },
    vat: {
      periodStart: "2026-01-01",
      periodEnd: "2026-06-30",
      periodLabel: "1. halvår 2026",
      outputVat: 4457,
      inputVat: 1086,
      payable: 3371,
    },
    exceptions: { count: 0, rows: [], groups: [] },
    recentEntries: [],
    ...over,
  };
}

const STATEMENT_COMPANY = {
  name: "Acme ApS",
  cvr: "DK12345678",
  country: "DK",
  currency: "DKK",
  fiscalYearStartMonth: 1,
  fiscalYearLabelStrategy: "end-year",
};

const STATEMENT_FISCAL_YEARS = [
  { label: "2026", start: "2026-01-01", end: "2026-12-31", source: "live" as const },
  { label: "2025", start: null, end: null, source: "archive" as const },
];

export function incomeStatement(
  over: Partial<CompanyIncomeStatement> = {},
): CompanyIncomeStatement {
  return {
    slug: "acme-aps",
    selectedYear: "2026",
    archived: false,
    company: STATEMENT_COMPANY,
    fiscalYears: STATEMENT_FISCAL_YEARS,
    income: [
      { accountNo: "1000", name: "Omsætning", amount: 17829.02, priorAmount: 0 },
    ],
    expense: [
      { accountNo: "3000", name: "Vareforbrug", amount: 4594.2, priorAmount: 0 },
    ],
    totalIncome: 17829.02,
    totalExpense: 4594.2,
    priorTotalIncome: 0,
    priorTotalExpense: 0,
    result: 13234.82,
    priorResult: 0,
    ...over,
  };
}

export function balance(over: Partial<CompanyBalance> = {}): CompanyBalance {
  return {
    slug: "acme-aps",
    selectedYear: "2026",
    archived: false,
    company: STATEMENT_COMPANY,
    fiscalYears: STATEMENT_FISCAL_YEARS,
    asOfDate: "2026-12-31",
    assets: {
      lines: [{ accountNo: "55000", name: "Bank", amount: 41388.03 }],
      total: 41388.03,
    },
    liabilities: {
      lines: [{ accountNo: "64000", name: "Salgsmoms", amount: 3371 }],
      total: 3371,
    },
    equity: {
      lines: [{ accountNo: "51000", name: "Selskabskapital", amount: 24782.21 }],
      total: 24782.21,
    },
    periodResult: 13234.82,
    totalAssets: 41388.03,
    totalLiabilitiesAndEquity: 41388.03,
    balanced: true,
    ...over,
  };
}

export function trialBalance(
  over: Partial<CompanyTrialBalance> = {},
): CompanyTrialBalance {
  return {
    slug: "acme-aps",
    selectedYear: "2026",
    archived: false,
    company: STATEMENT_COMPANY,
    fiscalYears: STATEMENT_FISCAL_YEARS,
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
    rows: [
      {
        accountNo: "1000",
        name: "Omsætning",
        type: "income",
        debit: 0,
        credit: 17829.02,
        balance: -17829.02,
      },
      {
        accountNo: "55000",
        name: "Bank",
        type: "asset",
        debit: 41388.03,
        credit: 0,
        balance: 41388.03,
      },
    ],
    totalDebit: 59217.05,
    totalCredit: 59217.05,
    balanced: true,
    ...over,
  };
}

export function journal(over: Partial<CompanyJournal> = {}): CompanyJournal {
  return {
    slug: "acme-aps",
    selectedYear: "2026",
    archived: false,
    company: STATEMENT_COMPANY,
    fiscalYears: STATEMENT_FISCAL_YEARS,
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
    entries: [
      {
        id: 1,
        entryNo: "B-2026-0001",
        date: "2026-03-15",
        text: "Salg af ydelse",
        total: 22286.28,
        lines: [
          {
            accountNo: "55000",
            accountName: "Bank",
            debit: 22286.28,
            credit: 0,
            text: null,
          },
          {
            accountNo: "1000",
            accountName: "Omsætning",
            debit: 0,
            credit: 17829.02,
            text: null,
          },
          {
            accountNo: "64000",
            accountName: "Salgsmoms",
            debit: 0,
            credit: 4457.26,
            text: null,
          },
        ],
      },
    ],
    ...over,
  };
}

export function bank(over: Partial<CompanyBank> = {}): CompanyBank {
  return {
    slug: "acme-aps",
    selectedYear: "2026",
    archived: false,
    company: STATEMENT_COMPANY,
    fiscalYears: STATEMENT_FISCAL_YEARS,
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
    accounts: [
      {
        id: 1,
        name: "Driftskonto",
        bankName: "Danske Bank",
        accountNo: "12345678",
        ledgerAccountNo: "55000",
      },
    ],
    bookedBalance: 41388.03,
    actualBalance: 23654.75,
    difference: 17733.28,
    transactions: [
      {
        id: 1,
        date: "2026-03-15",
        text: "Indbetaling faktura 1001",
        amount: 22286.28,
        runningBalance: 22286.28,
        reconciliationStatus: "matched",
        journalEntryNo: "B-2026-0001",
      },
      {
        id: 2,
        date: "2026-04-02",
        text: "Gebyr",
        amount: -45,
        runningBalance: 22241.28,
        reconciliationStatus: "unmatched",
        journalEntryNo: null,
      },
    ],
    matchedCount: 1,
    unmatchedCount: 1,
    ...over,
  };
}

export function vat(over: Partial<CompanyVat> = {}): CompanyVat {
  return {
    slug: "acme-aps",
    selectedYear: "2026",
    archived: false,
    company: STATEMENT_COMPANY,
    fiscalYears: STATEMENT_FISCAL_YEARS,
    periodStart: "2026-01-01",
    periodEnd: "2026-06-30",
    periodLabel: "1. halvår 2026",
    outputVat: 4457,
    inputVat: 1086,
    payable: 3371,
    ...over,
  };
}

export function documents(
  over: Partial<CompanyDocuments> = {},
): CompanyDocuments {
  return {
    slug: "acme-aps",
    company: STATEMENT_COMPANY,
    documents: [
      {
        id: 1,
        documentNo: "DOC-2026-000001",
        source: "dinero-import",
        filename: "2026-Bilag-1.pdf",
        documentType: "purchase_sale",
        supplierName: "Leverandør ApS",
        invoiceNo: "F-1001",
        invoiceDate: "2026-02-01",
        amountIncVat: 1250,
        currency: "DKK",
        status: "ingested",
        voucherRef: "1",
        journalEntryNo: "B-2026-0002",
        journalEntryId: 2,
      },
    ],
    linkedCount: 1,
    unlinkedCount: 0,
    ...over,
  };
}

/** The fiscal-years payload — drives the Arkiv view's year selector. */
export function fiscalYears(
  over: FiscalYearEntry[] = STATEMENT_FISCAL_YEARS,
): { slug: string; years: FiscalYearEntry[] } {
  return { slug: "acme-aps", years: over };
}

export function archive(
  over: Partial<CompanyArchiveYear> = {},
): CompanyArchiveYear {
  return {
    slug: "acme-aps",
    company: STATEMENT_COMPANY,
    year: "2025",
    sourceSystem: "dinero",
    importedAt: "2026-01-10T09:00:00.000Z",
    saldoBalance: [
      { accountNo: "1000", name: "Omsætning", amount: -42000 },
      { accountNo: "3000", name: "Vareforbrug", amount: 12500 },
      { accountNo: "55000", name: "Bank", amount: 29500 },
    ],
    postings: { count: 84, grossTotal: 168000 },
    ...over,
  };
}

export function multiYear(
  over: Partial<CompanyMultiYear> = {},
): CompanyMultiYear {
  return {
    slug: "acme-aps",
    company: STATEMENT_COMPANY,
    years: [
      {
        year: "2023",
        source: "archive",
        omsaetning: 31000,
        udgifter: 9000,
        resultat: 22000,
      },
      {
        year: "2024",
        source: "archive",
        omsaetning: 38000,
        udgifter: 11000,
        resultat: 27000,
      },
      {
        year: "2025",
        source: "archive",
        omsaetning: 42000,
        udgifter: 12500,
        resultat: 29500,
      },
      {
        year: "2026",
        source: "live",
        omsaetning: 17829.02,
        udgifter: 4594.2,
        resultat: 13234.82,
      },
    ],
    ...over,
  };
}

export function invoices(
  over: Partial<CompanyInvoices> = {},
): CompanyInvoices {
  return {
    slug: "acme-aps",
    selectedYear: "2026",
    archived: false,
    company: STATEMENT_COMPANY,
    fiscalYears: STATEMENT_FISCAL_YEARS,
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
    invoices: [
      {
        documentId: 1,
        invoiceNo: "2026-00001",
        invoiceDate: "2026-03-15",
        customerName: "Kunde A/S",
        grossAmount: 12500,
        openBalance: 0,
        currency: "DKK",
        status: "paid",
        effectiveDueDate: "2026-04-14",
        overdueDays: 0,
      },
      {
        documentId: 2,
        invoiceNo: "2026-00002",
        invoiceDate: "2026-04-01",
        customerName: "Beta ApS",
        grossAmount: 6250,
        openBalance: 6250,
        currency: "DKK",
        status: "overdue",
        effectiveDueDate: "2026-04-30",
        overdueDays: 21,
      },
    ],
    totalGross: 18750,
    totalOpen: 6250,
    overdueCount: 1,
    ...over,
  };
}

export function contacts(
  over: Partial<CompanyContacts> = {},
): CompanyContacts {
  return {
    slug: "acme-aps",
    company: STATEMENT_COMPANY,
    fiscalYears: STATEMENT_FISCAL_YEARS,
    customers: [
      {
        id: 1,
        name: "Kunde A/S",
        vatOrCvr: "DK87654321",
        email: "faktura@kunde.dk",
        paymentTermsDays: 30,
        defaultCurrency: "DKK",
      },
    ],
    vendors: [
      {
        id: 1,
        name: "Leverandør ApS",
        vatOrCvr: "DK11223344",
        defaultExpenseAccount: "3000",
        defaultVatTreatment: "standard",
      },
    ],
    ...over,
  };
}

type RouteMap = Record<string, unknown>;

/**
 * Installs a `fetch` mock. `routes` maps a `METHOD path` (path matched by
 * prefix, query stripped) to either a success payload, or `{__error}` to make
 * the route fail with the cockpit error envelope.
 */
export function mockFetch(routes: RouteMap) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      const method = (init?.method ?? "GET").toUpperCase();
      const key =
        Object.keys(routes).find((k) => {
          const [m, p] = k.split(" ");
          return m === method && path === p;
        }) ?? `${method} ${path}`;
      const payload = routes[key];
      if (payload === undefined) {
        return jsonResponse(
          { ok: false, error: { code: "not_found", message: "no route" } },
          404,
        );
      }
      if (
        payload &&
        typeof payload === "object" &&
        "__error" in (payload as Record<string, unknown>)
      ) {
        const e = (payload as { __error: { code: string; message: string } })
          .__error;
        return jsonResponse(
          { ok: false, error: e },
          e.code === "conflict" ? 409 : 400,
        );
      }
      return jsonResponse({ ok: true, ...(payload as object) });
    }),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
