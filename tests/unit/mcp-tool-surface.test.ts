// Tests: src/mcp/registry.ts, docs/mcp-tool-surface.md (MCP tool surface doc)
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DOC_PATH = join(process.cwd(), "docs/mcp-tool-surface.md");

const REQUIRED_SECTIONS = [
  "Designprincipper",
  "Klassifikation",
  "Read-tools",
  "Write-tools",
  "System-tools",
  "Eksempel-handshakes",
  "Actor-attribution",
  "Forudsætninger",
];

describe("docs/mcp-tool-surface.md", () => {
  test("file exists", () => {
    expect(existsSync(DOC_PATH)).toBe(true);
  });

  test("contains all required section headings", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    for (const section of REQUIRED_SECTIONS) {
      expect(content, `missing section: ${section}`).toContain(section);
    }
  });

  test("lists at least 25 tools across all tables", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    const toolRows = countToolRows(content);
    expect(toolRows).toBeGreaterThanOrEqual(25);
  });

  test("every tool name uses snake_case", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    const toolNames = extractToolNames(content);
    expect(toolNames.length).toBeGreaterThanOrEqual(25);
    const snakeCase = /^[a-z][a-z0-9_]*$/;
    for (const name of toolNames) {
      expect(snakeCase.test(name), `tool name not snake_case: ${name}`).toBe(true);
    }
  });

  test("documents at least one example handshake for both read and write", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).toMatch(/Read-tool: `audit_verify`/);
    expect(content).toMatch(/Write-tool: `journal_post`/);
    // Both example JSON payloads present
    expect(content).toContain('"name": "audit_verify"');
    expect(content).toContain('"name": "journal_post"');
  });

  test("classification table mentions all four levels", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).toContain("`read`");
    expect(content).toContain("`write-reversible`");
    expect(content).toContain("`write-irreversible`");
    expect(content).toContain("`destructive`");
  });

  test("documents the real tool total of 81 — not a stale count", () => {
    // #217 — the doc previously said "Total: 50" while the server exposed
    // 81 tools. Guard against the count drifting out of sync again.
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).toMatch(/\*\*?Total\*\*?\s*[:|]\s*\*\*?81\*\*?/);
    expect(content).not.toContain("Total**: 50");
  });

  test("does not describe period_list as a CLI command to be built", () => {
    // #217 — `period list` was never built as a CLI command; period_list
    // is an MCP-only tool. The doc must not claim a CLI command exists.
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).not.toMatch(/Kræver ny CLI-kommando/);
    // The CLI/MCP mapping gap must be documented explicitly instead.
    expect(content).toContain("CLI/MCP-mapping");
    expect(content).toMatch(/period_list[^\n]*ingen CLI-kommando/);
  });

  test("points the agent at the standalone-surface contract doc", () => {
    // #203 — the tool-surface doc must reference the agent contract.
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).toContain("mcp-agent-contract.md");
  });

  test("documents that every tool declares an outputSchema", () => {
    // #202 — the result contract must be discoverable from the surface doc.
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).toContain("outputSchema");
    // The shared envelope shape must be spelled out for the agent.
    expect(content).toMatch(/Resultat-shapes/);
  });

  test("does not promise an unbacked idempotencyKey on writes", () => {
    // #204 — the doc once promised retry-safe idempotency keys with a 24h
    // cache that was never implemented. The false promise must stay removed.
    const content = readFileSync(DOC_PATH, "utf8");
    // journal_post's input row must not advertise the dropped field.
    expect(content).not.toMatch(/journal_post[^\n]*idempotencyKey/);
    // No example handshake may pass an idempotencyKey argument.
    expect(content).not.toContain('"idempotencyKey"');
    // The doc must explicitly state there is no general idempotency mechanism.
    expect(content).toMatch(/[Ii]ngen generel idempotency-key/);
  });
});

describe("docs/mcp-agent-contract.md", () => {
  const CONTRACT_PATH = join(process.cwd(), "docs/mcp-agent-contract.md");

  test("file exists", () => {
    expect(existsSync(CONTRACT_PATH)).toBe(true);
  });

  test("covers the standalone tool surface conventions", () => {
    // #203 — a contract for the loose MCP tool surface (not the agent run
    // loop): ordering, confirm/destructive conventions, preconditions.
    const content = readFileSync(CONTRACT_PATH, "utf8");
    for (const topic of [
      "confirm",
      "confirmText",
      "destructive",
      "read before you write",
      "Preconditions",
      "idempotencyKey",
      "append-only",
    ]) {
      expect(content, `missing topic: ${topic}`).toContain(topic);
    }
    // It must distinguish itself from the agent run loop contract.
    expect(content).toContain("runtime-agent-contract.md");
  });

  test("does not promise retry-safe idempotency keys (#204)", () => {
    // #204 — the contract previously told agents that re-sending a write
    // with the same idempotencyKey would not double-post. That mechanism
    // does not exist; the contract must warn the opposite.
    const content = readFileSync(CONTRACT_PATH, "utf8");
    expect(content).toMatch(/no general `idempotencyKey` mechanism/i);
    expect(content).toMatch(/double-post/);
    // It must not still claim a key-keyed retry returns the original result.
    expect(content).not.toMatch(/same key does not double-post/);
  });
});

/**
 * Count rows in the tool tables by scanning for lines that look like
 * `| \`tool_name\` | ... |`. Header rows and separator rows are excluded
 * because they don't start with a backticked identifier.
 */
function countToolRows(content: string): number {
  const lines = content.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    if (/^\s*\|\s*`[a-z][a-z0-9_]*`\s*\|/.test(line)) count += 1;
  }
  return count;
}

function extractToolNames(content: string): string[] {
  const names = new Set<string>();
  const re = /^\s*\|\s*`([a-z][a-z0-9_]*)`\s*\|/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    names.add(match[1]!);
  }
  return [...names];
}
