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
  ClosePeriodInput,
  ClosePeriodResponse,
  ReopenPeriodInput,
  ReopenPeriodResponse,
  CompanyListResponse,
  CompanyProfileInput,
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

  /**
   * Updates the editable company profile + bank/payment details (#284). Only
   * the fields present in `input` are changed. The primary bank account it
   * creates is the one every issued-invoice payment block reads from.
   */
  updateCompanyProfile: (slug: string, input: CompanyProfileInput) =>
    request<CompanySettingsResponse>(
      `/api/companies/${encodeURIComponent(slug)}/company`,
      { method: "PATCH", body: JSON.stringify(input) },
    ).then((r) => r.company),

  syncCvr: (slug: string) =>
    request<SyncCvrResponse>(
      `/api/companies/${encodeURIComponent(slug)}/sync-cvr`,
      { method: "POST" },
    ).then((r) => r.sync),

  /**
   * Closes an accounting period (#287) — the prerequisite for a momsangivelse.
   * Calls the same `closeAccountingPeriod` core the CLI's `period close` uses.
   * Write-irreversible-shaped, so the server's pipeline requires `confirm`.
   */
  closePeriod: (slug: string, input: ClosePeriodInput) =>
    request<ClosePeriodResponse>(
      `/api/companies/${encodeURIComponent(slug)}/periods/close`,
      {
        method: "POST",
        body: JSON.stringify({
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.reference ? { reference: input.reference } : {}),
          confirm: true,
        }),
      },
    ).then((r) => r.period),

  /**
   * Reopens a closed accounting period (#301) — the controlled, audit-logged
   * recovery path for a period closed too early. `reason` is recorded verbatim
   * in the audit log. Calls the same `reopenAccountingPeriod` core the CLI's
   * `period reopen` uses; the server's pipeline requires `confirm`.
   */
  reopenPeriod: (slug: string, input: ReopenPeriodInput) =>
    request<ReopenPeriodResponse>(
      `/api/companies/${encodeURIComponent(slug)}/periods/reopen`,
      {
        method: "POST",
        body: JSON.stringify({
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          ...(input.kind ? { kind: input.kind } : {}),
          reason: input.reason,
          confirm: true,
        }),
      },
    ).then((r) => r.period),

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

  /**
   * Issues a sales invoice (#213, slice 4). The human enters the customer and
   * the line items; the server COMPUTES every line total, net, VAT and gross
   * via the same core path the CLI's `invoice create` uses — the human never
   * does invoice arithmetic. Issuing is a kladde (no journal entry yet), so no
   * `confirm` is required.
   */
  issueInvoice: (slug: string, input: InvoiceIssueInput) =>
    request<{ ok: true; invoice: InvoiceIssueSummary }>(
      `/api/companies/${encodeURIComponent(slug)}/invoices/issue`,
      {
        method: "POST",
        body: JSON.stringify({
          issueDate: input.issueDate,
          lines: input.lines,
          ...(input.vatRatePercent !== undefined
            ? { vatRatePercent: input.vatRatePercent }
            : {}),
          ...(input.customerId ? { customerId: input.customerId } : {}),
          ...(input.invoiceNumber ? { invoiceNumber: input.invoiceNumber } : {}),
          ...(input.dueDate ? { dueDate: input.dueDate } : {}),
          ...(input.currency ? { currency: input.currency } : {}),
          ...(input.seller ? { seller: input.seller } : {}),
          ...(input.buyer ? { buyer: input.buyer } : {}),
        }),
      },
    ).then((r) => r.invoice),

  /**
   * Posts an issued invoice to the ledger (#213, slice 4). Write-irreversible
   * (it appends a journal entry), so the body carries `confirm: true`.
   */
  postInvoice: (slug: string, invoiceDocumentId: number) =>
    request<{
      ok: true;
      posting: { entryId: number | null; entryNo: string | null };
    }>(`/api/companies/${encodeURIComponent(slug)}/invoices/post`, {
      method: "POST",
      body: JSON.stringify({ invoiceDocumentId, confirm: true }),
    }).then((r) => r.posting),

  /**
   * Settles an issued invoice against a bank payment (#213, slice 4). The
   * human identifies the bank receipt by its transaction id or reference.
   * Write-irreversible, so the body carries `confirm: true`.
   */
  settleInvoice: (slug: string, input: InvoiceSettleInput) =>
    request<{ ok: true; settlement: InvoiceSettleSummary }>(
      `/api/companies/${encodeURIComponent(slug)}/invoices/settle`,
      {
        method: "POST",
        body: JSON.stringify({
          invoiceDocumentId: input.invoiceDocumentId,
          ...(input.bankTransactionId
            ? { bankTransactionId: input.bankTransactionId }
            : {}),
          ...(input.bankTransactionReference
            ? { bankTransactionReference: input.bankTransactionReference }
            : {}),
          ...(input.paymentDate ? { paymentDate: input.paymentDate } : {}),
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          confirm: true,
        }),
      },
    ).then((r) => r.settlement),
};

/** A single invoice line as the human enters it — Rentemester computes totals. */
export type InvoiceLineInput = {
  description: string;
  quantity: number;
  unitPriceExVat: number;
};

/** An invoice party (seller / buyer) — all fields optional. */
export type InvoicePartyInput = {
  name?: string;
  address?: string;
  vatOrCvr?: string;
};

/** Input for `api.issueInvoice`. */
export type InvoiceIssueInput = {
  issueDate: string;
  lines: InvoiceLineInput[];
  vatRatePercent?: number;
  customerId?: number;
  invoiceNumber?: string;
  dueDate?: string;
  currency?: string;
  seller?: InvoicePartyInput;
  buyer?: InvoicePartyInput;
};

/** The issue result the server echoes back — every amount Rentemester computed. */
export type InvoiceIssueSummary = {
  documentId: number | null;
  invoiceNumber: string | null;
  netAmount: number;
  vatRate: number;
  vatAmount: number;
  grossAmount: number;
  lines: Array<InvoiceLineInput & { lineTotalExVat: number }>;
};

/** Input for `api.settleInvoice`. */
export type InvoiceSettleInput = {
  invoiceDocumentId: number;
  bankTransactionId?: number;
  bankTransactionReference?: string;
  paymentDate?: string;
  amount?: number;
};

/** The settlement result the server echoes back. */
export type InvoiceSettleSummary = {
  entryId: number | null;
  paymentId: number | null;
  principalAmount: number;
  claimAmount: number;
  invoiceNumber: string | null;
  openBalance: number | null;
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
