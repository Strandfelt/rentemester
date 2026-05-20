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
  listWorkspaceCompanies,
  workspaceExists,
} from "../core/workspace";
import type { ServerConfig } from "./config";
import { authMiddleware } from "./auth";
import { ApiError, toErrorResponse } from "./errors";
import {
  buildCompanyDashboardData,
  buildPortfolioOverview,
  resolveAsOfDate,
} from "./data";

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

    if (path === "/" || path === "/api" || path === "/api/health") {
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

    throw ApiError.notFound("no such endpoint");
  } catch (err) {
    // (4) Single error edge. ApiError → its code; anything else → generic 500
    // with no leaked detail.
    const { status, body } = toErrorResponse(err);
    return jsonResponse(body, status);
  }
}
