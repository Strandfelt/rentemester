/**
 * Late-interest invoice_* MCP tools: invoice_claim_interest,
 * invoice_post_interest.
 *
 * Split out of `../invoice.ts` (Batch G). Registration order preserved.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  registerInvoiceLateInterest,
  postInvoiceLateInterestToLedger,
} from "../../../core/invoice-interest";
import { envelopeShape, errorEnvelope, wrapCoreResult } from "../../envelope";
import {
  withCompanyDbConfirmed,
  resolveIssuedInvoiceDocumentId,
  confirmField,
} from "../../tool-runtime";
import {
  docIdOrNumberSchema,
  notFoundEnvelope,
  requireInvoicePostedEnvelope,
  POSTED_REQUIRED_PREFIX,
} from "./_shared";

function hasRegisteredInterestClaim(
  db: import("bun:sqlite").Database,
  documentId: number,
): boolean {
  const row = db
    .query(
      `SELECT id FROM invoice_interest_claims WHERE invoice_document_id = ? LIMIT 1`,
    )
    .get(documentId) as { id: number } | null;
  return row != null;
}

export function registerInvoiceInterestTools(server: McpServer): void {
  server.registerTool(
    "invoice_claim_interest",
    {
      title: "Register late-interest claim",
      description:
        "Registrerer morarentekrav (uden at bogføre — kald invoice_post_interest bagefter). " +
        "Forudsætning: fakturaen skal være bogført med invoice_post og være forfalden. " +
        "write-irreversible.",
      inputSchema: {
        ...docIdOrNumberSchema,
        asOf: z
          .string()
          .min(1)
          .describe("As-of date in YYYY-MM-DD format the late interest is computed up to."),
        referenceRate: z
          .number()
          .describe(
            "Nationalbanken's reference rate as a percentage (e.g. 2.65 for 2.65%); " +
              "the statutory late-interest surcharge is added on top.",
          ),
        note: z.string().optional().describe("Optional free-text note on the interest claim."),
        confirm: confirmField,
      },
      outputSchema: envelopeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      documentId?: number;
      invoiceNumber?: string;
      asOf: string;
      referenceRate: number;
      note?: string;
      confirm?: boolean;
    }>(server, "invoice_claim_interest", ({ db, args }) => {
      const id = resolveIssuedInvoiceDocumentId(db, args);
      if (!id) return notFoundEnvelope(args);
      const blocked = requireInvoicePostedEnvelope(db, id, "invoice_claim_interest");
      if (blocked) return blocked;
      const result = registerInvoiceLateInterest(db, {
        invoiceDocumentId: id,
        asOfDate: args.asOf,
        referenceRatePercent: args.referenceRate,
        note: args.note,
      });
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_post_interest",
    {
      title: "Post late-interest claim to ledger",
      description:
        "Bogfører registreret morarentekrav (renten indtægtsføres). " +
        "Forudsætning: et morarentekrav skal være registreret med invoice_claim_interest først. " +
        "write-irreversible.",
      inputSchema: {
        ...docIdOrNumberSchema,
        claimId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional ID of the specific registered interest claim to post. When " +
              "omitted, the latest unposted interest claim on the invoice is posted.",
          ),
        date: z
          .string()
          .optional()
          .describe(
            "Posting date in YYYY-MM-DD format. When omitted, the claim's own date is used.",
          ),
        confirm: confirmField,
      },
      outputSchema: envelopeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      documentId?: number;
      invoiceNumber?: string;
      claimId?: number;
      date?: string;
      confirm?: boolean;
    }>(server, "invoice_post_interest", ({ db, args }) => {
      const id = resolveIssuedInvoiceDocumentId(db, args);
      if (!id) return notFoundEnvelope(args);
      if (!hasRegisteredInterestClaim(db, id)) {
        return errorEnvelope(
          `${POSTED_REQUIRED_PREFIX} der er ingen registreret morarentekrav på faktura documentId=${id}. ` +
            `Kald invoice_claim_interest først for at registrere kravet før invoice_post_interest.`,
        );
      }
      const result = postInvoiceLateInterestToLedger(db, {
        invoiceDocumentId: id,
        claimId: args.claimId,
        transactionDate: args.date,
      });
      return wrapCoreResult(result);
    }),
  );
}
