// The single HTTP seam between the cockpit SPA and `rentemester serve` (#170).
//
// Every backend response is `{ok:true,...}` or `{ok:false,error:{code,message}}`.
// `request` normalises both into a typed value or a thrown `ApiError`, so views
// only ever deal with data or a single error type.

import type {
  ArchiveResponse,
  BalanceResponse,
  BankResponse,
  CashflowResponse,
  CompanyListResponse,
  CompanySettingsResponse,
  ContactsResponse,
  CreateCompanyInput,
  DashboardResponse,
  DocumentsResponse,
  FiscalYearsResponse,
  HealthResponse,
  IncomeStatementResponse,
  InvoicesResponse,
  JournalResponse,
  MultiYearResponse,
  ObligationsResponse,
  OverviewResponse,
  PortfolioResponse,
  SyncCvrResponse,
  TrialBalanceResponse,
  UpdateCompanyInput,
  VatResponse,
} from "./types";

/** A failed API call — carries the backend error code for precise handling. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(
      "network",
      "Kunne ikke nå serveren. Kører `rentemester serve`?",
      0,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError("internal", "Serveren gav et ugyldigt svar.", res.status);
  }

  if (body && typeof body === "object" && (body as { ok?: unknown }).ok === false) {
    const err = (body as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(
      err?.code ?? "internal",
      err?.message ?? "Ukendt serverfejl.",
      res.status,
    );
  }
  if (!res.ok) {
    throw new ApiError("internal", `HTTP ${res.status}`, res.status);
  }
  return body as T;
}

export const api = {
  health: () => request<HealthResponse>("/api/health"),

  portfolio: (asOf?: string) =>
    request<PortfolioResponse>(
      `/api/portfolio${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ""}`,
    ).then((r) => r.portfolio),

  companies: () =>
    request<CompanyListResponse>("/api/companies").then((r) => r.companies),

  dashboard: (slug: string, asOf?: string) =>
    request<DashboardResponse>(
      `/api/companies/${encodeURIComponent(slug)}/dashboard${
        asOf ? `?asOf=${encodeURIComponent(asOf)}` : ""
      }`,
    ).then((r) => r.dashboard),

  fiscalYears: (slug: string) =>
    request<FiscalYearsResponse>(
      `/api/companies/${encodeURIComponent(slug)}/fiscal-years`,
    ).then((r) => r.fiscalYears.years),

  overview: (slug: string, year?: string) =>
    request<OverviewResponse>(
      `/api/companies/${encodeURIComponent(slug)}/overview${
        year ? `?year=${encodeURIComponent(year)}` : ""
      }`,
    ).then((r) => r.overview),

  incomeStatement: (slug: string, year?: string) =>
    request<IncomeStatementResponse>(
      `/api/companies/${encodeURIComponent(slug)}/income-statement${
        year ? `?year=${encodeURIComponent(year)}` : ""
      }`,
    ).then((r) => r.incomeStatement),

  balance: (slug: string, year?: string) =>
    request<BalanceResponse>(
      `/api/companies/${encodeURIComponent(slug)}/balance${
        year ? `?year=${encodeURIComponent(year)}` : ""
      }`,
    ).then((r) => r.balance),

  trialBalance: (slug: string, year?: string) =>
    request<TrialBalanceResponse>(
      `/api/companies/${encodeURIComponent(slug)}/trial-balance${
        year ? `?year=${encodeURIComponent(year)}` : ""
      }`,
    ).then((r) => r.trialBalance),

  journal: (slug: string, year?: string, account?: string) => {
    const params = new URLSearchParams();
    if (year) params.set("year", year);
    if (account) params.set("account", account);
    const query = params.toString();
    return request<JournalResponse>(
      `/api/companies/${encodeURIComponent(slug)}/journal${
        query ? `?${query}` : ""
      }`,
    ).then((r) => r.journal);
  },

  bank: (slug: string, year?: string) =>
    request<BankResponse>(
      `/api/companies/${encodeURIComponent(slug)}/bank${
        year ? `?year=${encodeURIComponent(year)}` : ""
      }`,
    ).then((r) => r.bank),

  vat: (slug: string, year?: string) =>
    request<VatResponse>(
      `/api/companies/${encodeURIComponent(slug)}/vat${
        year ? `?year=${encodeURIComponent(year)}` : ""
      }`,
    ).then((r) => r.vat),

  documents: (slug: string) =>
    request<DocumentsResponse>(
      `/api/companies/${encodeURIComponent(slug)}/documents`,
    ).then((r) => r.documents),

  archive: (slug: string, year: string) =>
    request<ArchiveResponse>(
      `/api/companies/${encodeURIComponent(slug)}/archive/${encodeURIComponent(
        year,
      )}`,
    ).then((r) => r.archive),

  multiYear: (slug: string) =>
    request<MultiYearResponse>(
      `/api/companies/${encodeURIComponent(slug)}/multi-year`,
    ).then((r) => r.multiYear),

  invoices: (slug: string, year?: string) =>
    request<InvoicesResponse>(
      `/api/companies/${encodeURIComponent(slug)}/invoices${
        year ? `?year=${encodeURIComponent(year)}` : ""
      }`,
    ).then((r) => r.invoices),

  contacts: (slug: string) =>
    request<ContactsResponse>(
      `/api/companies/${encodeURIComponent(slug)}/contacts`,
    ).then((r) => r.contacts),

  obligations: (slug: string, year?: string) =>
    request<ObligationsResponse>(
      `/api/companies/${encodeURIComponent(slug)}/obligations${
        year ? `?year=${encodeURIComponent(year)}` : ""
      }`,
    ).then((r) => r.obligations),

  cashflow: (slug: string, year?: string) =>
    request<CashflowResponse>(
      `/api/companies/${encodeURIComponent(slug)}/cashflow${
        year ? `?year=${encodeURIComponent(year)}` : ""
      }`,
    ).then((r) => r.cashflow),

  createCompany: (input: CreateCompanyInput) =>
    request<{ ok: true; company: { slug: string; name: string } }>(
      "/api/companies",
      { method: "POST", body: JSON.stringify(input) },
    ).then((r) => r.company),

  updateCompany: (slug: string, input: UpdateCompanyInput) =>
    request<{ ok: true; company: { slug: string; name: string; archived: boolean } }>(
      `/api/companies/${encodeURIComponent(slug)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    ).then((r) => r.company),

  companySettings: (slug: string) =>
    request<CompanySettingsResponse>(
      `/api/companies/${encodeURIComponent(slug)}/company`,
    ).then((r) => r.company),

  syncCvr: (slug: string) =>
    request<SyncCvrResponse>(
      `/api/companies/${encodeURIComponent(slug)}/sync-cvr`,
      { method: "POST" },
    ).then((r) => r.sync),

  // --- write actions (#213) -----------------------------------------------
  //
  // Bookkeeping mutations. The server routes these through the
  // `withCompanyMutation` pipeline (backup lock, actor attribution); a 409
  // means the backup lock is engaged — callers render that kindly.

  /** Resolves an open exception. `note` is optional free text. */
  resolveException: (slug: string, id: number, note?: string) =>
    request<{ ok: true; exception: { id: number; resolved: boolean } }>(
      `/api/companies/${encodeURIComponent(slug)}/exceptions/${id}/resolve`,
      {
        method: "POST",
        body: JSON.stringify(note ? { note } : {}),
      },
    ).then((r) => r.exception),

  /**
   * Imports a bank-statement CSV (#213, slice 2). The browser reads the file
   * and passes its text as `csvContent`; the server writes it to a temp file
   * and calls the same core import the CLI/MCP use. Destructive, so the body
   * carries `confirm: true`.
   */
  importBank: (slug: string, input: BankImportInput) =>
    request<{ ok: true; import: BankImportSummary }>(
      `/api/companies/${encodeURIComponent(slug)}/bank/import`,
      {
        method: "POST",
        body: JSON.stringify({
          csvContent: input.csvContent,
          ...(input.account ? { account: input.account } : {}),
          ...(input.profile ? { profile: input.profile } : {}),
          confirm: true,
        }),
      },
    ).then((r) => r.import),

  /**
   * Ingests a document/voucher (bilag) (#213, slice 3). The browser reads the
   * (possibly binary) file and passes it base64-encoded; the server decodes it
   * to a temp file and calls the same core ingest the CLI/MCP use. Destructive,
   * so the body carries `confirm: true`.
   */
  ingestDocument: (slug: string, input: DocumentIngestInput) =>
    request<{
      ok: true;
      document: { id: number | null; documentNo: string | null };
    }>(`/api/companies/${encodeURIComponent(slug)}/documents/ingest`, {
      method: "POST",
      body: JSON.stringify({
        fileName: input.fileName,
        fileBase64: input.fileBase64,
        metadata: input.metadata,
        ...(input.vendorId ? { vendorId: input.vendorId } : {}),
        ...(input.force ? { force: true } : {}),
        confirm: true,
      }),
    }).then((r) => r.document),
};

/** Input for `api.importBank` — the CSV text plus optional account/profile. */
export type BankImportInput = {
  csvContent: string;
  account?: string;
  profile?: string;
};

/** The bank-import result the server echoes back. */
export type BankImportSummary = {
  importBatchId?: string;
  imported: number;
  skippedDuplicates: number;
  skippedDuplicateRows: string[];
  bankAccountSlug?: string;
  profile?: string;
  balanceWarnings: string[];
  exceptionsCreated: number;
};

/** Document metadata for `api.ingestDocument` — amounts are kroner (decimal DKK). */
export type DocumentIngestMetadata = {
  source: string;
  documentType?: "purchase_sale" | "cash_register_receipt";
  issueDate?: string;
  invoiceNo?: string;
  deliveryDescription?: string;
  amountIncVat?: number;
  currency?: string;
  sender?: { name?: string; address?: string; vatOrCvr?: string };
  recipient?: { name?: string; address?: string; vatOrCvr?: string };
  vatAmount?: number;
  paymentDetails?: string;
};

/** Input for `api.ingestDocument` — the base64 file plus its metadata. */
export type DocumentIngestInput = {
  fileName: string;
  fileBase64: string;
  metadata: DocumentIngestMetadata;
  vendorId?: number;
  force?: boolean;
};
