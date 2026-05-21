#!/usr/bin/env bun
/**
 * Rentemester MCP-server (stdio transport).
 *
 * Eksponerer hele Rentemester-tool-surface'en (81 tools, jf.
 * docs/mcp-tool-surface.md) over stdio, så Claude Desktop / Cursor /
 * Claude Code / Codex kan tale med Rentemester-kernen som MCP-tools.
 * Tools registreres pr. domæne af `registerAllTools` i `./registry`.
 *
 * Serveren leverer også en `instructions`-streng i `initialize`-svaret —
 * en kort orientering til en agent om rækkefølge, confirm/destructive-
 * konventioner og hvor forudsætningerne ligger. Den fulde kontrakt for
 * den løse tool-surface står i docs/mcp-agent-contract.md.
 *
 * Brug:
 *   bun src/mcp/server.ts                  # start over stdio
 *   bun src/mcp/server.ts --company /path  # accepteres men ikke krævet;
 *                                           agenten passer typisk
 *                                           `company` per tool-call.
 *
 * Globalt installeret:
 *   rentemester-mcp                        # via package.json "bin"
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./registry";

const SERVER_NAME = "rentemester-mcp";
const SERVER_VERSION = "0.0.1";

/**
 * Orientering der sendes til agenten i `initialize`-svarets
 * `instructions`-felt. Holdes kort og handlingsanvisende — den fulde
 * kontrakt for den løse tool-surface står i docs/mcp-agent-contract.md.
 */
const SERVER_INSTRUCTIONS = [
  "Rentemester er et dansk, append-only bogføringssystem. Du driver det via løse tools — der er ingen samtale-state mellem kald.",
  "",
  "Identifikation: hvert tool tager en eksplicit absolut `company`-sti (workspace-tools tager `workspace`). Der er aldrig en implicit \"current company\".",
  "",
  "Sikkerhedsklasser (se hvert tools `annotations`): read er bivirkningsfri og må kaldes frit; write-tools kræver `confirm: true` i argumenterne ellers afvises kaldet før kernen kaldes; det destruktive `system_restore_backup` kræver derudover `confirmText: \"RESTORE <targetCompany>\"`.",
  "",
  "Rækkefølge: læs før du skriver. Et typisk flow er validate/status/list (read) → issue/post/settle (write). Bogføring sker i en hash-kædet append-only ledger — der findes ingen sletning; en fejlpostering rettes med en modpostering (journal_reverse / invoice_credit_note) eller løses via exception_resolve.",
  "",
  "Forudsætninger og fejl: hvert kald svarer med konvolutten { ok, data?, errors[], appliedRules? }. ok=false betyder at en forudsætning manglede — errors[] forklarer hvad (fx manglende confirm, ubalanceret postering, manglende VIES-validering, periode-lås eller en aktiv backup-lås). Ret forudsætningen og kald igen; gæt aldrig.",
  "",
  "Idempotens: writes accepterer en valgfri `idempotencyKey` så en retry ikke dobbelt-bogfører. Backup-låsen kan blokere bogføring hvis den ugentlige backup er forsømt — kør da system_backup (archive:true) for at låse op.",
  "",
  "Den fulde kontrakt — tool-katalog, rækkefølge og konventioner — står i docs/mcp-tool-surface.md og docs/mcp-agent-contract.md.",
].join("\n");

async function main(): Promise<void> {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  registerAllTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Forbliv kørende indtil stdin lukkes; SDK'en lukker transport
  // automatisk når den ser EOF.
}

main().catch((error) => {
  // Skriv til stderr så stdout-stream'en (MCP-framing) ikke bliver
  // korrumperet af logs.
  console.error("[rentemester-mcp] fatal:", error);
  process.exit(1);
});
