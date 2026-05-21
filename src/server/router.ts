// HTTP request handler for the cockpit backend (#170).
//
// `handleRequest` is the pure heart of the server: a `(Request, config) =>
// Promise<Response>` with no `Bun.serve` dependency, so tests drive it
// directly. `src/cli/serve.ts` wires it into `Bun.serve`.
//
// Request flow, in order, for EVERY request:
//   1. authMiddleware  — the single auth seam (throws ApiError to reject)
//   2. route dispatch  — match method + path
//   3. handler         — reads/workspace-management only, never a mutation
//   4. error edge      — any throw is mapped to a safe JSON error here
//
// No handler does its own auth and no handler shapes its own errors: both
// concerns live exactly once, here.

import { createCompany } from "../core/company";
import {
  findWorkspaceCompany,
  listWorkspaceCompanies,
  renameWorkspaceCompany,
  setWorkspaceCompanyArchived,
  workspaceExists,
} from "../core/workspace";
import type { ServerConfig } from "./config";
import { authMiddleware } from "./auth";
import { ApiError, toErrorResponse } from "./errors";
import {
  buildCompanyArchiveYear,
  buildCompanyBalance,
  buildCompanyBank,
  buildCompanyContacts,
  buildCompanyDashboardData,
  buildCompanyDocuments,
  buildCompanyFiscalYears,
  buildCompanyIncomeStatement,
  buildCompanyInvoices,
  buildCompanyJournal,
  buildCompanyMultiYear,
  buildCompanyOverview,
  buildCompanyTrialBalance,
  buildCompanyVat,
  buildPortfolioOverview,
  resolveAsOfDate,
  resolvePathYear,
  resolveYearParam,
} from "./data";
import { serveStatic } from "./static";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function okResponse(body: Record<string, unknown>, status = 200): Response {
  return jsonResponse({ ok: true, ...body }, status);
}

/** Parses a JSON request body, mapping any failure to a safe 400. */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw ApiError.badRequest("request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw ApiError.badRequest("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireString(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw ApiError.badRequest(`'${key}' is required and must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw ApiError.badRequest(`'${key}' must be a string when present`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// --------------------------------------------------------------------------
// Route handlers — reads + workspace management only.
// --------------------------------------------------------------------------

function handleHealth(config: ServerConfig): Response {
  return okResponse({
    service: "rentemester-cockpit",
    workspace: config.workspaceRoot,
    authRequired: config.authRequired,
  });
}

function handlePortfolio(config: ServerConfig, url: URL): Response {
  const asOf = resolveAsOfDate(url.searchParams.get("asOf"));
  const overview = buildPortfolioOverview(config.workspaceRoot, asOf);
  return okResponse({ portfolio: overview });
}

function handleCompanyList(config: ServerConfig): Response {
  const companies = workspaceExists(config.workspaceRoot)
    ? listWorkspaceCompanies(config.workspaceRoot)
    : [];
  return okResponse({
    workspace: config.workspaceRoot,
    count: companies.length,
    companies: companies.map((c) => ({
      slug: c.slug,
      name: c.name,
      createdAt: c.createdAt,
      archived: c.archived,
    })),
  });
}

function handleCompanyDashboard(
  config: ServerConfig,
  slug: string,
  url: URL,
): Response {
  const asOf = resolveAsOfDate(url.searchParams.get("asOf"));
  const data = buildCompanyDashboardData(config.workspaceRoot, slug, asOf);
  return okResponse({ dashboard: data });
}

function handleCompanyFiscalYears(config: ServerConfig, slug: string): Response {
  const data = buildCompanyFiscalYears(config.workspaceRoot, slug);
  return okResponse({ fiscalYears: data });
}

function handleCompanyOverview(
  config: ServerConfig,
  slug: string,
  url: URL,
): Response {
  const year = resolveYearParam(url.searchParams.get("year"));
  const data = buildCompanyOverview(config.workspaceRoot, slug, year);
  return okResponse({ overview: data });
}

function handleCompanyIncomeStatement(
  config: ServerConfig,
  slug: string,
  url: URL,
): Response {
  const year = resolveYearParam(url.searchParams.get("year"));
  const data = buildCompanyIncomeStatement(config.workspaceRoot, slug, year);
  return okResponse({ incomeStatement: data });
}

function handleCompanyBalance(
  config: ServerConfig,
  slug: string,
  url: URL,
): Response {
  const year = resolveYearParam(url.searchParams.get("year"));
  const data = buildCompanyBalance(config.workspaceRoot, slug, year);
  return okResponse({ balance: data });
}

function handleCompanyTrialBalance(
  config: ServerConfig,
  slug: string,
  url: URL,
): Response {
  const year = resolveYearParam(url.searchParams.get("year"));
  const data = buildCompanyTrialBalance(config.workspaceRoot, slug, year);
  return okResponse({ trialBalance: data });
}

function handleCompanyJournal(
  config: ServerConfig,
  slug: string,
  url: URL,
): Response {
  const year = resolveYearParam(url.searchParams.get("year"));
  const data = buildCompanyJournal(config.workspaceRoot, slug, year);
  return okResponse({ journal: data });
}

function handleCompanyBank(
  config: ServerConfig,
  slug: string,
  url: URL,
): Response {
  const year = resolveYearParam(url.searchParams.get("year"));
  const data = buildCompanyBank(config.workspaceRoot, slug, year);
  return okResponse({ bank: data });
}

function handleCompanyVat(
  config: ServerConfig,
  slug: string,
  url: URL,
): Response {
  const year = resolveYearParam(url.searchParams.get("year"));
  const data = buildCompanyVat(config.workspaceRoot, slug, year);
  return okResponse({ vat: data });
}

function handleCompanyDocuments(config: ServerConfig, slug: string): Response {
  const data = buildCompanyDocuments(config.workspaceRoot, slug);
  return okResponse({ documents: data });
}

function handleCompanyArchiveYear(
  config: ServerConfig,
  slug: string,
  yearRaw: string,
): Response {
  const year = resolvePathYear(yearRaw);
  const data = buildCompanyArchiveYear(config.workspaceRoot, slug, year);
  return okResponse({ archive: data });
}

function handleCompanyMultiYear(config: ServerConfig, slug: string): Response {
  const data = buildCompanyMultiYear(config.workspaceRoot, slug);
  return okResponse({ multiYear: data });
}

function handleCompanyInvoices(
  config: ServerConfig,
  slug: string,
  url: URL,
): Response {
  const year = resolveYearParam(url.searchParams.get("year"));
  const data = buildCompanyInvoices(config.workspaceRoot, slug, year);
  return okResponse({ invoices: data });
}

function handleCompanyContacts(config: ServerConfig, slug: string): Response {
  const data = buildCompanyContacts(config.workspaceRoot, slug);
  return okResponse({ contacts: data });
}

async function handleCompanyCreate(
  config: ServerConfig,
  request: Request,
): Promise<Response> {
  const body = await readJsonBody(request);
  const name = requireString(body, "name");
  let result;
  try {
    result = createCompany(config.workspaceRoot, {
      name,
      slug: optionalString(body, "slug"),
      cvr: optionalString(body, "cvr") ?? null,
      fiscalYearStartMonth: optionalString(body, "fiscalYearStartMonth"),
      fiscalYearLabelStrategy: optionalString(body, "fiscalYearLabelStrategy"),
    });
  } catch (err) {
    // createCompany throws plain Errors for invalid slug / duplicate. Re-map
    // them to a safe code; the messages it produces are curated (no paths)
    // — except `companyRoot`, which createCompany only embeds for the
    // "already exists" case, so collapse that to a generic conflict.
    const message = err instanceof Error ? err.message : String(err);
    if (/already exists|already registered/i.test(message)) {
      throw ApiError.conflict("a company with that slug already exists");
    }
    throw ApiError.badRequest(message);
  }
  return okResponse(
    {
      company: { slug: result.slug, name: result.name },
    },
    201,
  );
}

/**
 * Updates a registered company's mutable workspace metadata: the display
 * `name` and/or the `archived` flag. This never touches the slug or the
 * ledger — there is deliberately NO destructive delete of ledger data.
 */
async function handleCompanyUpdate(
  config: ServerConfig,
  slug: string,
  request: Request,
): Promise<Response> {
  if (!findWorkspaceCompany(config.workspaceRoot, slug)) {
    throw ApiError.notFound(`no company with slug '${slug}' in the workspace`);
  }
  const body = await readJsonBody(request);
  const name = optionalString(body, "name");
  const archivedRaw = body.archived;
  if (archivedRaw !== undefined && typeof archivedRaw !== "boolean") {
    throw ApiError.badRequest("'archived' must be a boolean when present");
  }
  if (name === undefined && archivedRaw === undefined) {
    throw ApiError.badRequest("provide 'name' and/or 'archived' to update");
  }
  try {
    let entry = findWorkspaceCompany(config.workspaceRoot, slug)!;
    if (name !== undefined) {
      entry = renameWorkspaceCompany(config.workspaceRoot, slug, name);
    }
    if (typeof archivedRaw === "boolean") {
      entry = setWorkspaceCompanyArchived(config.workspaceRoot, slug, archivedRaw);
    }
    return okResponse({
      company: {
        slug: entry.slug,
        name: entry.name,
        createdAt: entry.createdAt,
        archived: entry.archived,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw ApiError.badRequest(message);
  }
}

// --------------------------------------------------------------------------
// Dispatch
// --------------------------------------------------------------------------

/**
 * Handles one HTTP request end-to-end. Always resolves to a `Response` —
 * thrown `ApiError`s (and any other error) are mapped to safe JSON here.
 */
export async function handleRequest(
  request: Request,
  config: ServerConfig,
): Promise<Response> {
  try {
    // (1) The single auth seam — runs before any route logic. Phase 2 swaps
    // the body of authMiddleware; this call site never changes.
    authMiddleware(request, config);

    // (2) Route dispatch.
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    if (path === "/api" || path === "/api/health") {
      if (method !== "GET") throw ApiError.methodNotAllowed("GET required");
      return handleHealth(config);
    }

    if (path === "/api/portfolio") {
      if (method !== "GET") throw ApiError.methodNotAllowed("GET required");
      return handlePortfolio(config, url);
    }

    if (path === "/api/companies") {
      if (method === "GET") return handleCompanyList(config);
      if (method === "POST") return await handleCompanyCreate(config, request);
      throw ApiError.methodNotAllowed("GET or POST required");
    }

    const dashboardMatch = /^\/api\/companies\/([^/]+)\/dashboard$/.exec(path);
    if (dashboardMatch) {
      if (method !== "GET") throw ApiError.methodNotAllowed("GET required");
      const slug = decodeURIComponent(dashboardMatch[1]!);
      return handleCompanyDashboard(config, slug, url);
    }

    const fiscalYearsMatch = /^\/api\/companies\/([^/]+)\/fiscal-years$/.exec(path);
    if (fiscalYearsMatch) {
      if (method !== "GET") throw ApiError.methodNotAllowed("GET required");
      const slug = decodeURIComponent(fiscalYearsMatch[1]!);
      return handleCompanyFiscalYears(config, slug);
    }

    const overviewMatch = /^\/api\/companies\/([^/]+)\/overview$/.exec(path);
    if (overviewMatch) {
      if (method !== "GET") throw ApiError.methodNotAllowed("GET required");
      const slug = decodeURIComponent(overviewMatch[1]!);
      return handleCompanyOverview(config, slug, url);
    }

    const incomeStatementMatch =
      /^\/api\/companies\/([^/]+)\/income-statement$/.exec(path);
    if (incomeStatementMatch) {
      if (method !== "GET") throw ApiError.methodNotAllowed("GET required");
      const slug = decodeURIComponent(incomeStatementMatch[1]!);
      return handleCompanyIncomeStatement(config, slug, url);
    }

    const balanceMatch = /^\/api\/companies\/([^/]+)\/balance$/.exec(path);
    if (balanceMatch) {
      if (method !== "GET") throw ApiError.methodNotAllowed("GET required");
      const slug = decodeURIComponent(balanceMatch[1]!);
      return handleCompanyBalance(config, slug, url);
    }

    const trialBalanceMatch =
      /^\/api\/companies\/([^/]+)\/trial-balance$/.exec(path);
    if (trialBalanceMatch) {
      if (method !== "GET") throw ApiError.methodNotAllowed("GET required");
      const slug = decodeURIComponent(trialBalanceMatch[1]!);
      return handleCompanyTrialBalance(config, slug, url);
    }

    const journalMatch = /^\/api\/companies\/([^/]+)\/journal$/.exec(path);
    if (journalMatch) {
      if (method !== "GET") throw ApiError.methodNotAllowed("GET required");
      const slug = decodeURIComponent(journalMatch[1]!);
      return handleCompanyJournal(config, slug, url);
    }

    const bankMatch = /^\/api\/companies\/([^/]+)\/bank$/.exec(path);
    if (bankMatch) {
      if (method !== "GET") throw ApiError.methodNotAllowed("GET required");
      const slug = decodeURIComponent(bankMatch[1]!);
      return handleCompanyBank(config, slug, url);
    }

    const vatMatch = /^\/api\/companies\/([^/]+)\/vat$/.exec(path);
    if (vatMatch) {
      if (method !== "GET") throw ApiError.methodNotAllowed("GET required");
      const slug = decodeURIComponent(vatMatch[1]!);
      return handleCompanyVat(config, slug, url);
    }

    const documentsMatch = /^\/api\/companies\/([^/]+)\/documents$/.exec(path);
    if (documentsMatch) {
      if (method !== "GET") throw ApiError.methodNotAllowed("GET required");
      const slug = decodeURIComponent(documentsMatch[1]!);
      return handleCompanyDocuments(config, slug);
    }

    const archiveMatch =
      /^\/api\/companies\/([^/]+)\/archive\/([^/]+)$/.exec(path);
    if (archiveMatch) {
      if (method !== "GET") throw ApiError.methodNotAllowed("GET required");
      const slug = decodeURIComponent(archiveMatch[1]!);
      const year = decodeURIComponent(archiveMatch[2]!);
      return handleCompanyArchiveYear(config, slug, year);
    }

    const multiYearMatch = /^\/api\/companies\/([^/]+)\/multi-year$/.exec(path);
    if (multiYearMatch) {
      if (method !== "GET") throw ApiError.methodNotAllowed("GET required");
      const slug = decodeURIComponent(multiYearMatch[1]!);
      return handleCompanyMultiYear(config, slug);
    }

    const invoicesMatch = /^\/api\/companies\/([^/]+)\/invoices$/.exec(path);
    if (invoicesMatch) {
      if (method !== "GET") throw ApiError.methodNotAllowed("GET required");
      const slug = decodeURIComponent(invoicesMatch[1]!);
      return handleCompanyInvoices(config, slug, url);
    }

    const contactsMatch = /^\/api\/companies\/([^/]+)\/contacts$/.exec(path);
    if (contactsMatch) {
      if (method !== "GET") throw ApiError.methodNotAllowed("GET required");
      const slug = decodeURIComponent(contactsMatch[1]!);
      return handleCompanyContacts(config, slug);
    }

    const companyMatch = /^\/api\/companies\/([^/]+)$/.exec(path);
    if (companyMatch) {
      const slug = decodeURIComponent(companyMatch[1]!);
      if (method === "PATCH") return await handleCompanyUpdate(config, slug, request);
      throw ApiError.methodNotAllowed("PATCH required");
    }

    // Anything under /api that did not match a route is a JSON 404. Any other
    // path is a cockpit-SPA route: serve the built app (with the index.html
    // fallback) when it exists, else fall through to the JSON 404.
    if (!path.startsWith("/api")) {
      if (method === "GET" || method === "HEAD") {
        const asset = serveStatic(config.staticRoot, path);
        if (asset) return asset;
        // No SPA built — keep `/` a friendly health probe for API-only runs.
        if (path === "/") return handleHealth(config);
      }
    }

    throw ApiError.notFound("no such endpoint");
  } catch (err) {
    // (4) Single error edge. ApiError → its code; anything else → generic 500
    // with no leaked detail.
    const { status, body } = toErrorResponse(err);
    return jsonResponse(body, status);
  }
}
