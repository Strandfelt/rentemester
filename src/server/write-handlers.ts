// Cockpit write route handlers (#213, slice 1).
//
// Each handler here is a thin adapter: it parses route params + body, runs the
// shared `withCompanyMutation` pipeline (which owns the backup lock, the
// confirm gate, actor resolution and the localhost hard-gate), and calls the
// existing `src/core/` bookkeeping function. The Cockpit NEVER reimplements
// bookkeeping — it is a third caller of core, alongside the CLI and MCP.
//
// Slice 1 ships the resolve-exception action. Slices 2-3 add bank CSV import
// and document (bilag) intake — both file-upload routes: the frontend reads
// the file in the browser and POSTs its content inline (CSV as text, the
// binary document as base64), and the handler writes it to a `mkdtemp` file
// before calling core. Slice 4 (invoicing) follows the same shape.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
  resolveException,
  syncUnmatchedBankTransactionExceptions,
} from "../core/exceptions";
import { importBankCsv } from "../core/bank";
import { ingestDocument, type DocumentMetadata } from "../core/documents";
import { resolveDocumentMasterData } from "../core/master-data";
import type { ServerConfig } from "./config";
import { ApiError } from "./errors";
import { withCockpitActor } from "./actor";
import { withCompanyMutation } from "./mutations";

/**
 * Max request-body size for the file-upload routes (#213, slices 2-3). A bank
 * CSV or a base64-encoded document is far larger than slice 1's tiny JSON
 * body, but still bounded — 12 MiB comfortably covers a multi-year CSV export
 * or a scanned multi-page PDF (base64 inflates bytes by ~33%) while refusing a
 * body that would exhaust memory. The guard runs in `withCompanyMutation`
 * before the body is read.
 */
const MAX_UPLOAD_BODY_BYTES = 12 * 1024 * 1024;

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

/** Reads a required, non-empty string body field, mapping a bad value to a 400. */
function requireBodyString(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw ApiError.badRequest(`'${key}' is required and must be a non-empty string`);
  }
  return value;
}

/** Reads an optional positive-integer body field, mapping a bad value to a 400. */
function optionalBodyPositiveInt(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw ApiError.badRequest(`'${key}' must be a positive integer when present`);
  }
  return value;
}

/**
 * POST /api/companies/:slug/bank/import — imports a bank-statement CSV.
 *
 * Body: `{ csvContent: string, account?: string, profile?: string,
 * confirm: true }`. The frontend reads the chosen CSV file in the browser and
 * POSTs its text as `csvContent`; the handler writes it to a `mkdtemp` file
 * and calls the SAME `importBankCsv` core function the CLI/MCP use, then runs
 * `syncUnmatchedBankTransactionExceptions` exactly as `bank import` does.
 *
 * Destructive (it appends ledger rows) so `requireConfirm` is set — the body
 * must carry `confirm: true`. A `maxBodyBytes` cap hardens the upload route.
 * Goes through `withCompanyMutation`, so the backup lock, the localhost gate
 * and actor attribution all apply.
 */
export async function handleBankImport(
  config: ServerConfig,
  request: Request,
  slug: string,
): Promise<Response> {
  const result = await withCompanyMutation(
    request,
    config,
    slug,
    (ctx, body) => {
      const csvContent = requireBodyString(body, "csvContent");
      const account = optionalBodyString(body, "account");
      const profile = optionalBodyString(body, "profile");

      // Mirror the MCP `csvContent` pattern: persist the inline CSV to a
      // private temp file, then hand core a path — core reads from disk.
      const tmpDir = mkdtempSync(join(tmpdir(), "rentemester-cockpit-bank-"));
      const csvPath = join(tmpDir, "bank-import.csv");
      writeFileSync(csvPath, csvContent, "utf8");

      const imported = importBankCsv(ctx.db, ctx.companyRoot, csvPath, {
        account,
        profile,
      });
      // The CLI/MCP both sync unmatched-transaction exceptions after a
      // successful import — replicate that so the Cockpit behaves identically.
      const sync = imported.ok
        ? syncUnmatchedBankTransactionExceptions(ctx.db)
        : { ok: true, created: 0, errors: [] };
      return {
        ...(imported as Record<string, unknown>),
        ok: imported.ok,
        errors: imported.errors,
        exceptionsCreated: sync.created,
      };
    },
    { requireConfirm: true, maxBodyBytes: MAX_UPLOAD_BODY_BYTES },
  );

  // The core `BankImportResult` shape is echoed back so the UI can report the
  // batch id, the imported/skipped counts and any balance warnings.
  return okResponse({
    import: {
      importBatchId: result.importBatchId,
      imported: result.imported ?? 0,
      skippedDuplicates: result.skippedDuplicates ?? 0,
      skippedDuplicateRows: result.skippedDuplicateRows ?? [],
      bankAccountSlug: result.bankAccountSlug,
      profile: result.profile,
      balanceWarnings: result.balanceWarnings ?? [],
      exceptionsCreated: result.exceptionsCreated ?? 0,
    },
  });
}

/**
 * Parses + validates the `metadata` body field into a core `DocumentMetadata`.
 * The shape mirrors the MCP `documents_ingest` input — amounts are kroner.
 * Anything malformed is a 400; core's `validateDocumentMetadata` performs the
 * deeper bookkeeping validation.
 */
function parseDocumentMetadata(raw: unknown): DocumentMetadata {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw ApiError.badRequest("'metadata' is required and must be an object");
  }
  const m = raw as Record<string, unknown>;

  function str(key: string): string | undefined {
    const v = m[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") {
      throw ApiError.badRequest(`metadata.${key} must be a string when present`);
    }
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
  function num(key: string): number | undefined {
    const v = m[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw ApiError.badRequest(`metadata.${key} must be a number when present`);
    }
    return v;
  }
  function party(key: string): DocumentMetadata["sender"] {
    const v = m[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "object" || Array.isArray(v)) {
      throw ApiError.badRequest(`metadata.${key} must be an object when present`);
    }
    const p = v as Record<string, unknown>;
    for (const f of ["name", "address", "vatOrCvr"]) {
      if (p[f] !== undefined && p[f] !== null && typeof p[f] !== "string") {
        throw ApiError.badRequest(`metadata.${key}.${f} must be a string when present`);
      }
    }
    const trim = (x: unknown) =>
      typeof x === "string" && x.trim().length > 0 ? x.trim() : undefined;
    return { name: trim(p.name), address: trim(p.address), vatOrCvr: trim(p.vatOrCvr) };
  }

  const source = str("source");
  if (!source) {
    throw ApiError.badRequest("metadata.source is required");
  }
  const documentType = m.documentType;
  if (
    documentType !== undefined &&
    documentType !== "purchase_sale" &&
    documentType !== "cash_register_receipt"
  ) {
    throw ApiError.badRequest(
      "metadata.documentType must be 'purchase_sale' or 'cash_register_receipt'",
    );
  }
  const exemptionCode = m.exemptionCode;
  if (
    exemptionCode !== undefined &&
    exemptionCode !== null &&
    exemptionCode !== "FOREIGN_PHYSICAL_ONLY"
  ) {
    throw ApiError.badRequest(
      "metadata.exemptionCode must be 'FOREIGN_PHYSICAL_ONLY' or null when present",
    );
  }

  return {
    source,
    documentType: documentType as DocumentMetadata["documentType"],
    issueDate: str("issueDate"),
    invoiceNo: str("invoiceNo"),
    deliveryDescription: str("deliveryDescription"),
    amountIncVat: num("amountIncVat"),
    currency: str("currency"),
    sender: party("sender"),
    recipient: party("recipient"),
    vatAmount: num("vatAmount"),
    paymentDetails: str("paymentDetails"),
    exemptionCode: (exemptionCode ?? undefined) as DocumentMetadata["exemptionCode"],
  };
}

/**
 * POST /api/companies/:slug/documents/ingest — ingests a voucher/document.
 *
 * Body: `{ fileName: string, fileBase64: string, metadata: {...},
 * vendorId?: number, force?: boolean, confirm: true }`. The document file is
 * binary (a PDF/PNG/JPEG, or a plain-text receipt), so the frontend base64-
 * encodes it; the handler decodes it to a `mkdtemp` file — keeping the
 * original file extension, which `core/documents` keys its MIME detection on
 * — and calls the SAME `ingestDocument` (+ `resolveDocumentMasterData`) core
 * functions the CLI/MCP use. No multipart.
 *
 * Destructive (it hash-stores the bilag and may post) so `requireConfirm` is
 * set. A `maxBodyBytes` cap hardens the upload route. Goes through
 * `withCompanyMutation` — backup lock, localhost gate, actor attribution.
 */
export async function handleDocumentIngest(
  config: ServerConfig,
  request: Request,
  slug: string,
): Promise<Response> {
  const result = await withCompanyMutation(
    request,
    config,
    slug,
    (ctx, body) => {
      const fileName = requireBodyString(body, "fileName");
      const fileBase64 = requireBodyString(body, "fileBase64");
      const metadata = parseDocumentMetadata(body.metadata);
      const vendorId = optionalBodyPositiveInt(body, "vendorId");
      if (body.force !== undefined && typeof body.force !== "boolean") {
        throw ApiError.badRequest("'force' must be a boolean when present");
      }
      const force = body.force === true;

      // Decode the inline file to a private temp file. The extension is
      // preserved from the client filename because `core/documents`
      // resolves the MIME type from it (and cross-checks the magic bytes).
      let bytes: Buffer;
      try {
        bytes = Buffer.from(fileBase64, "base64");
      } catch {
        throw ApiError.badRequest("'fileBase64' must be valid base64");
      }
      if (bytes.length === 0) {
        throw ApiError.badRequest("'fileBase64' decodes to an empty file");
      }
      const ext = extname(fileName).toLowerCase();
      const tmpDir = mkdtempSync(join(tmpdir(), "rentemester-cockpit-doc-"));
      const filePath = join(tmpDir, `document${ext}`);
      writeFileSync(filePath, bytes);

      // Master-data resolution mirrors the CLI/MCP: a given `vendorId`
      // back-fills the sender from the registered vendor.
      const resolved = resolveDocumentMasterData(ctx.db, metadata, { vendorId });
      if (!resolved.ok) {
        return { ok: false, errors: resolved.errors ?? ["master-data resolution failed"] };
      }
      const ingested = ingestDocument(ctx.db, ctx.companyRoot, filePath, resolved.metadata, {
        forceDuplicateLogicalIdentity: force,
      });
      return {
        ok: ingested.ok,
        errors: ingested.errors,
        documentId: ingested.documentId,
        documentNo: ingested.documentNo,
      };
    },
    { requireConfirm: true, maxBodyBytes: MAX_UPLOAD_BODY_BYTES },
  );

  return okResponse({
    document: {
      id: result.documentId ?? null,
      documentNo: result.documentNo ?? null,
    },
  });
}
