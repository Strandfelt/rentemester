// Cockpit write route handlers (#213, slice 1).
//
// Each handler here is a thin adapter: it parses route params + body, runs the
// shared `withCompanyMutation` pipeline (which owns the backup lock, the
// confirm gate, actor resolution and the localhost hard-gate), and calls the
// existing `src/core/` bookkeeping function. The Cockpit NEVER reimplements
// bookkeeping — it is a third caller of core, alongside the CLI and MCP.
//
// Slice 1 ships exactly one action: resolving an open exception. Slices 2–4
// add bank import, document intake and invoicing the same way.

import { resolveException } from "../core/exceptions";
import type { ServerConfig } from "./config";
import { ApiError } from "./errors";
import { withCockpitActor } from "./actor";
import { withCompanyMutation } from "./mutations";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function okResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status,
    headers: JSON_HEADERS,
  });
}

/** Parses a positive-integer path segment, mapping a bad value to a 400. */
function parseIdParam(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw ApiError.badRequest(`'${label}' must be a positive integer`);
  }
  return value;
}

/** Reads an optional string body field, trimming and collapsing empty to undefined. */
function optionalBodyString(
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

/**
 * POST /api/companies/:slug/exceptions/:id/resolve — clears an open exception.
 *
 * Body: `{ note?: string }`. Non-destructive (the exception stays in the
 * ledger, only its status flips to `resolved`), so no `confirm` is required —
 * the Cockpit modal is the human's consent.
 *
 * Goes through `withCompanyMutation`, so the backup lock, the localhost gate
 * and actor attribution all apply. The resolved actor is recorded as the
 * exception's `resolvedBy`, so the audit trail shows the Cockpit cleared it.
 */
export async function handleResolveException(
  config: ServerConfig,
  request: Request,
  slug: string,
  idRaw: string,
): Promise<Response> {
  const id = parseIdParam(idRaw, "id");

  const result = await withCompanyMutation(
    request,
    config,
    slug,
    (ctx, body) => {
      const note = optionalBodyString(body, "note");
      // The actor flows through as `resolvedBy` (an explicit payload param —
      // never an env var), so a Cockpit-cleared exception is attributable.
      const payload = withCockpitActor(
        { id, note: note ?? null, resolvedBy: ctx.actor.createdBy },
        ctx.actor,
      );
      return resolveException(ctx.db, payload);
    },
  );

  return okResponse({
    exception: { id, resolved: result.resolved },
  });
}
