/**
 * MCP-tool: `audit_verify` (read).
 *
 * 1:1-mapping af CLI-kommandoen `audit verify`. Verificerer hash-chain
 * og bogføringsintegritet for en virksomhedsmappe.
 *
 * Klassifikation: `read` — ingen state-bivirkninger, må kaldes frit.
 * Kræver derfor ikke `confirm: true`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { verifyAuditChain } from "../../core/ledger";
import { envelopeShape, wrapCoreResult } from "../envelope";
import { withCompanyDb } from "../tool-runtime";

const inputSchema = {
  company: z.string().min(1, "company path is required"),
};

export function registerAuditTools(server: McpServer): void {
  server.registerTool(
    "audit_verify",
    {
      title: "Verify audit chain",
      description:
        "Verificerer hash-chain og bogføringsintegritet for virksomhedsmappen. " +
        "Returnerer { ok, entries, errors[] }. Read-only — ingen state-bivirkninger.",
      inputSchema,
      outputSchema: envelopeShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withCompanyDb<{ company: string }>(server, ({ db }) => {
      // `withCompanyDb` already resolves + existsSync-guards `company` and
      // returns a *path-redacted* error envelope on a bad/missing directory,
      // so the absolute host path is never disclosed to the caller (#228).
      return wrapCoreResult(verifyAuditChain(db));
    }),
  );
}
