// Test fixtures + a fetch mock that speaks the cockpit API's JSON envelope.

import { vi } from "vitest";
import type {
  CompanyDashboard,
  CompanyOverview,
  CompanySummary,
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
    bank: { balance: 41388.03 },
    vat: {
      periodStart: "2026-01-01",
      periodEnd: "2026-06-30",
      periodLabel: "1. halvår 2026",
      outputVat: 4457,
      inputVat: 1086,
      payable: 3371,
    },
    exceptions: { count: 0, rows: [] },
    recentEntries: [],
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
