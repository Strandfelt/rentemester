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
import { resolveDocumentMasterData, resolveInvoiceMasterData } from "../core/master-data";
import {
  computeInvoiceAmounts,
  type InvoiceLineInput,
  type InvoicePayload,
} from "../core/invoice";
import { issueInvoice } from "../core/issued-invoices";
import { postIssuedInvoiceToLedger } from "../core/invoice-booking";
import { settleInvoiceFromBank } from "../core/invoice-settlement";
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

// --------------------------------------------------------------------------
// Slice 4 — invoicing.
//
// Three human-mode invoice actions, each routed through `withCompanyMutation`
// and each a third caller of the SAME `src/core/` functions the CLI
// (`src/cli/invoice.ts`) and MCP (`src/mcp/tools/invoice.ts`) use:
//
//   - issue   — the human enters customer + line items; Rentemester COMPUTES
//               every total via `computeInvoiceAmounts`, exactly as the CLI's
//               guided `invoice create` command does. The human never does
//               invoice arithmetic. Issuing is non-destructive at the ledger
//               level (no journal entry yet — a kladde), so no `requireConfirm`.
//   - post    — `postIssuedInvoiceToLedger`. Write-irreversible (it appends a
//               journal entry), so `requireConfirm: true`.
//   - settle  — `settleInvoiceFromBank`. Write-irreversible (it links a bank
//               receipt + appends a journal entry), so `requireConfirm: true`.
// --------------------------------------------------------------------------

/**
 * Reads a required positive-integer body field, mapping a bad value to a 400.
 * Used for the invoice document id on the post/settle routes.
 */
function requireBodyPositiveInt(
  body: Record<string, unknown>,
  key: string,
): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw ApiError.badRequest(`'${key}' is required and must be a positive integer`);
  }
  return value;
}

/** Reads an optional finite-number body field, mapping a bad value to a 400. */
function optionalBodyNumber(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw ApiError.badRequest(`'${key}' must be a number when present`);
  }
  return value;
}

/**
 * Parses the `lines` body field into core `InvoiceLineInput[]`. Each line is
 * the three essentials a human supplies — description, quantity, unit price
 * ex-VAT. Anything malformed is a 400; `computeInvoiceAmounts` performs the
 * deeper numeric validation (quantity > 0, etc.) and is the single source of
 * truth for every derived amount.
 */
function parseInvoiceLines(raw: unknown): InvoiceLineInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw ApiError.badRequest("'lines' is required and must be a non-empty array");
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw ApiError.badRequest(`lines[${index}] must be an object`);
    }
    const line = entry as Record<string, unknown>;
    if (typeof line.description !== "string" || line.description.trim().length === 0) {
      throw ApiError.badRequest(`lines[${index}].description is required and must be a non-empty string`);
    }
    if (typeof line.quantity !== "number" || !Number.isFinite(line.quantity)) {
      throw ApiError.badRequest(`lines[${index}].quantity is required and must be a number`);
    }
    if (typeof line.unitPriceExVat !== "number" || !Number.isFinite(line.unitPriceExVat)) {
      throw ApiError.badRequest(`lines[${index}].unitPriceExVat is required and must be a number`);
    }
    return {
      description: line.description.trim(),
      quantity: line.quantity,
      unitPriceExVat: line.unitPriceExVat,
    };
  });
}

/**
 * POST /api/companies/:slug/invoices/issue — issues a sales invoice.
 *
 * Body: `{ issueDate: string, lines: [{description, quantity, unitPriceExVat}],
 * vatRatePercent?: number, customerId?: number, buyer?: {name,address,vatOrCvr},
 * seller?: {name,address,vatOrCvr}, invoiceNumber?: string, dueDate?: string,
 * currency?: string }`.
 *
 * Rentemester COMPUTES every line total, the net amount, the VAT amount and
 * the gross amount from the human's minimal input — the exact compute path of
 * the CLI's guided `invoice create` command (`computeInvoiceAmounts` →
 * `issueInvoice`). The human never hand-writes an amount. A stored
 * `customerId` back-fills the buyer from master data, exactly as the CLI does.
 *
 * Issuing produces a kladde (no journal entry yet), so it is NOT marked
 * `requireConfirm` — the multi-line modal IS the human's consent. The route
 * still goes through `withCompanyMutation` for the backup lock, the localhost
 * gate and actor attribution.
 */
export async function handleInvoiceIssue(
  config: ServerConfig,
  request: Request,
  slug: string,
): Promise<Response> {
  const result = await withCompanyMutation(
    request,
    config,
    slug,
    (ctx, body) => {
      const issueDate = requireBodyString(body, "issueDate");
      const lines = parseInvoiceLines(body.lines);
      const vatRatePercent = optionalBodyNumber(body, "vatRatePercent") ?? 25;
      const customerId = optionalBodyPositiveInt(body, "customerId");
      const invoiceNumber = optionalBodyString(body, "invoiceNumber");
      const dueDate = optionalBodyString(body, "dueDate");
      const currency = optionalBodyString(body, "currency");

      // The human types either a stored --customer-id or the buyer details
      // directly — same as `invoice create`. `parseInvoiceParty` keeps a
      // partially-filled party object so master-data / validation can fill or
      // reject it.
      const buyer = parseInvoiceParty(body.buyer, "buyer");
      const seller = parseInvoiceParty(body.seller, "seller");

      // Rentemester computes every derived amount — the human never does
      // invoice arithmetic. A compute rejection (blank line, bad quantity) is
      // a core `{ok:false}` and surfaces as a 400 via `withCompanyMutation`.
      const computed = computeInvoiceAmounts(lines, vatRatePercent);
      if (!computed.ok) {
        return { ok: false, errors: computed.errors };
      }

      const payload: InvoicePayload = {
        invoiceType: "full",
        vatTreatment: "standard",
        issueDate,
        ...(invoiceNumber ? { invoiceNumber } : {}),
        seller,
        buyer,
        lines: computed.lines,
        totals: {
          netAmount: computed.totals.netAmount,
          vatRate: computed.totals.vatRate,
          vatAmount: computed.totals.vatAmount,
          grossAmount: computed.totals.grossAmount,
        },
        currency: currency ?? "DKK",
        ...(dueDate ? { dueDate } : {}),
      };

      // Master-data resolution mirrors the CLI: a given `customerId` back-fills
      // the buyer name/address/VAT from the registered customer.
      const resolved = resolveInvoiceMasterData(ctx.db, payload, { customerId });
      if (!resolved.ok) {
        return { ok: false, errors: resolved.errors ?? ["master-data resolution failed"] };
      }
      const issued = issueInvoice(ctx.db, ctx.companyRoot, resolved.payload);
      return {
        ok: issued.ok,
        errors: issued.errors,
        documentId: issued.documentId,
        invoiceNumber: issued.invoiceNumber,
        computed,
      };
    },
  );

  // Echo the computed amounts so the modal can show the human exactly what
  // Rentemester worked out from their input.
  return okResponse({
    invoice: {
      documentId: result.documentId ?? null,
      invoiceNumber: result.invoiceNumber ?? null,
      netAmount: result.computed?.totals?.netAmount ?? 0,
      vatRate: result.computed?.totals?.vatRate ?? 0,
      vatAmount: result.computed?.totals?.vatAmount ?? 0,
      grossAmount: result.computed?.totals?.grossAmount ?? 0,
      lines: result.computed?.lines ?? [],
    },
  });
}

/**
 * Parses an optional invoice party (`buyer` / `seller`) body field into the
 * partial-object shape `InvoicePayload` expects. Each field is optional — the
 * core validator / master-data resolution is the authority on completeness.
 */
function parseInvoiceParty(
  raw: unknown,
  label: string,
): { name?: string; address?: string; vatOrCvr?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw ApiError.badRequest(`'${label}' must be an object when present`);
  }
  const p = raw as Record<string, unknown>;
  const party: { name?: string; address?: string; vatOrCvr?: string } = {};
  for (const field of ["name", "address", "vatOrCvr"] as const) {
    const v = p[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") {
      throw ApiError.badRequest(`'${label}.${field}' must be a string when present`);
    }
    const trimmed = v.trim();
    if (trimmed.length > 0) party[field] = trimmed;
  }
  return party;
}

/**
 * POST /api/companies/:slug/invoices/post — posts an issued invoice to the
 * ledger.
 *
 * Body: `{ invoiceDocumentId: number, transactionDate?: string,
 * confirm: true }`. Calls the SAME `postIssuedInvoiceToLedger` core function
 * the CLI's `invoice post` command uses.
 *
 * Write-irreversible — it appends a journal entry — so `requireConfirm` is
 * set. A double-post is refused by core (`invoice X already has journal entry
 * Y`), which `withCompanyMutation` maps to a 409 conflict.
 */
export async function handleInvoicePost(
  config: ServerConfig,
  request: Request,
  slug: string,
): Promise<Response> {
  const result = await withCompanyMutation(
    request,
    config,
    slug,
    (ctx, body) => {
      const invoiceDocumentId = requireBodyPositiveInt(body, "invoiceDocumentId");
      const transactionDate = optionalBodyString(body, "transactionDate");
      const posted = postIssuedInvoiceToLedger(
        ctx.db,
        withCockpitActor(
          { invoiceDocumentId, transactionDate },
          ctx.actor,
        ),
      );
      return {
        ok: posted.ok,
        errors: posted.errors,
        entryId: posted.entryId,
        entryNo: posted.entryNo,
      };
    },
    { requireConfirm: true },
  );

  return okResponse({
    posting: {
      entryId: result.entryId ?? null,
      entryNo: result.entryNo ?? null,
    },
  });
}

/**
 * POST /api/companies/:slug/invoices/settle — settles an issued invoice
 * against a bank payment.
 *
 * Body: `{ invoiceDocumentId: number, bankTransactionId?: number,
 * bankTransactionReference?: string, paymentDate?: string, amount?: number,
 * confirm: true }`. Calls the SAME `settleInvoiceFromBank` core function the
 * CLI's `invoice settle-bank` command uses.
 *
 * Write-irreversible — it links a bank receipt and appends a journal entry —
 * so `requireConfirm` is set. A double-settle is refused by core (`bank
 * transaction N is already linked …`), mapped to a 409 conflict.
 */
export async function handleInvoiceSettle(
  config: ServerConfig,
  request: Request,
  slug: string,
): Promise<Response> {
  const result = await withCompanyMutation(
    request,
    config,
    slug,
    (ctx, body) => {
      const invoiceDocumentId = requireBodyPositiveInt(body, "invoiceDocumentId");
      const bankTransactionId = optionalBodyPositiveInt(body, "bankTransactionId");
      const bankTransactionReference = optionalBodyString(
        body,
        "bankTransactionReference",
      );
      const paymentDate = optionalBodyString(body, "paymentDate");
      const amount = optionalBodyNumber(body, "amount");
      if (bankTransactionId === undefined && bankTransactionReference === undefined) {
        throw ApiError.badRequest(
          "'bankTransactionId' or 'bankTransactionReference' is required",
        );
      }
      const settled = settleInvoiceFromBank(
        ctx.db,
        withCockpitActor(
          {
            invoiceDocumentId,
            bankTransactionId,
            bankTransactionReference,
            paymentDate,
            amount,
          },
          ctx.actor,
        ),
      );
      return {
        ok: settled.ok,
        errors: settled.errors,
        entryId: settled.entryId,
        paymentId: settled.paymentId,
        principalAmount: settled.principalAmount,
        claimAmount: settled.claimAmount,
        invoiceNumber: settled.invoiceNumber,
        openBalance: settled.openBalance,
      };
    },
    { requireConfirm: true },
  );

  return okResponse({
    settlement: {
      entryId: result.entryId ?? null,
      paymentId: result.paymentId ?? null,
      principalAmount: result.principalAmount ?? 0,
      claimAmount: result.claimAmount ?? 0,
      invoiceNumber: result.invoiceNumber ?? null,
      openBalance: result.openBalance ?? null,
    },
  });
}
