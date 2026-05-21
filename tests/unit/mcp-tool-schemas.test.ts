// Tests: src/mcp/tool-runtime.ts, src/mcp/tools (typed payload schemas + confirm envelope)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { seedAccounts } from "../../src/core/ledger";

/**
 * Coverage for #200/#201/#206/#208/#210:
 *
 *  - #201: an *omitted* `confirm` must yield the same structured
 *    `{ ok:false, errors:[...] }` envelope as `confirm:false` — NOT a raw
 *    JSON-RPC `-32602` error with no `structuredContent`.
 *  - #200/#206: the write tools expose fully-typed payload schemas — the
 *    `tools/list` inputSchema carries field-level descriptions (incl. amount
 *    units) and required/optional status.
 *  - #208: `journal_post`'s `payload.documentId` is documented as required
 *    for expense/income lines.
 *  - #210: `documents_ingest`'s `filePath` is documented as server-side.
 */

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number;
  result?: any;
  error?: { code: number; message: string };
};

const SERVER_PATH = new URL("../../src/mcp/server.ts", import.meta.url).pathname;

class StdioMcpClient {
  private proc: ReturnType<typeof Bun.spawn>;
  private stdoutReader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = "";
  private nextId = 1;

  constructor() {
    this.proc = Bun.spawn(["bun", SERVER_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.stdoutReader = this.proc.stdout.getReader();
  }

  async send(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const request = { jsonrpc: "2.0", id, method, params: params ?? {} };
    await this.proc.stdin.write(JSON.stringify(request) + "\n");
    await (this.proc.stdin as any).flush?.();
    return this.readResponse(id);
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const note = { jsonrpc: "2.0", method, params: params ?? {} };
    await this.proc.stdin.write(JSON.stringify(note) + "\n");
    await (this.proc.stdin as any).flush?.();
  }

  private async readResponse(expectedId: number): Promise<JsonRpcResponse> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx === -1) {
        const { value, done } = await this.stdoutReader.read();
        if (done) throw new Error("MCP server closed stdout before responding");
        this.buffer += this.decoder.decode(value, { stream: true });
        continue;
      }
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      const parsed: JsonRpcResponse = JSON.parse(line);
      if (parsed.id === expectedId) return parsed;
    }
    throw new Error(`Timed out waiting for MCP response id=${expectedId}`);
  }

  async close(): Promise<void> {
    try {
      this.proc.stdin.end();
    } catch {}
    try {
      this.stdoutReader.releaseLock();
    } catch {}
    this.proc.kill();
    await this.proc.exited;
  }
}

let companyRoot: string;
let client: StdioMcpClient;

beforeAll(async () => {
  companyRoot = mkdtempSync(join(tmpdir(), "mcp-schemas-company-"));
  const paths = ensureCompanyDirs(companyRoot);
  const db = openDb(paths.db);
  migrate(db);
  seedAccounts(db);
  db.close();

  client = new StdioMcpClient();
  const initResponse = await client.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "rentemester-schema-test", version: "0.0.1" },
  });
  expect(initResponse.error).toBeUndefined();
  await client.notify("notifications/initialized");
});

afterAll(async () => {
  await client.close();
  if (companyRoot && existsSync(companyRoot)) {
    rmSync(companyRoot, { recursive: true, force: true });
  }
});

describe("#201 — an omitted confirm yields an error envelope, not a raw -32602", () => {
  // The set of write tools whose confirm-gating must survive an omitted flag.
  const cases: Array<{ name: string; args: Record<string, unknown> }> = [
    {
      name: "journal_post",
      args: {
        company: "__COMPANY__",
        payload: {
          transactionDate: "2026-05-18",
          text: "confirm omitted",
          lines: [
            { accountNo: "2000", debitAmount: 100 },
            { accountNo: "5000", creditAmount: 100 },
          ],
        },
        // confirm intentionally omitted
      },
    },
    {
      name: "invoice_issue",
      args: {
        company: "__COMPANY__",
        payload: { invoiceType: "full", invoiceNumber: "X" },
        // confirm intentionally omitted
      },
    },
    {
      name: "period_close",
      args: {
        company: "__COMPANY__",
        from: "2026-05-01",
        to: "2026-05-31",
        // confirm intentionally omitted
      },
    },
  ];

  for (const { name, args } of cases) {
    test(`${name}: omitted confirm returns { ok:false, errors:[...] } envelope`, async () => {
      const resolved = JSON.parse(
        JSON.stringify(args).replace(/__COMPANY__/g, companyRoot),
      );
      const response = await client.send("tools/call", { name, arguments: resolved });
      // The whole point: no raw JSON-RPC error, a structured envelope instead.
      expect(response.error).toBeUndefined();
      const structured = response.result?.structuredContent;
      expect(structured).toBeDefined();
      expect(structured.ok).toBe(false);
      expect(Array.isArray(structured.errors)).toBe(true);
      expect(
        structured.errors.some((m: string) => m.includes("confirm: true required")),
      ).toBe(true);
    });
  }

  test("an omitted confirm produces the same envelope as confirm:false", async () => {
    const base = {
      company: companyRoot,
      payload: { invoiceType: "full" as const, invoiceNumber: "X" },
    };
    const omitted = await client.send("tools/call", {
      name: "invoice_issue",
      arguments: base,
    });
    const explicitFalse = await client.send("tools/call", {
      name: "invoice_issue",
      arguments: { ...base, confirm: false },
    });
    expect(omitted.result?.structuredContent).toEqual(
      explicitFalse.result?.structuredContent,
    );
  });
});

describe("#200/#206/#208/#210 — write tools expose fully-typed input schemas", () => {
  let tools: any[];

  beforeAll(async () => {
    const response = await client.send("tools/list");
    tools = response.result?.tools ?? [];
  });

  function schemaOf(name: string) {
    const tool = tools.find((t) => t.name === name);
    expect(tool, `tool ${name} not found`).toBeDefined();
    return tool.inputSchema as any;
  }

  test("invoice_issue payload is a typed object, not an empty catchall", () => {
    const schema = schemaOf("invoice_issue");
    const payload = schema.properties?.payload;
    expect(payload?.type).toBe("object");
    // A real contract: the discriminating invoiceType field is present.
    expect(payload?.properties?.invoiceType).toBeDefined();
    expect(payload?.properties?.totals).toBeDefined();
    // Field-level descriptions exist.
    expect(typeof payload?.properties?.invoiceType?.description).toBe("string");
  });

  test("#206 — invoice totals fields state the kroner unit", () => {
    const schema = schemaOf("invoice_issue");
    const totals = schema.properties?.payload?.properties?.totals;
    const grossDesc: string = totals?.properties?.grossAmount?.description ?? "";
    expect(grossDesc.toLowerCase()).toContain("kroner");
    const vatRateDesc: string = totals?.properties?.vatRate?.description ?? "";
    // vatRate is a fraction, not a monetary amount — must be documented as such.
    expect(vatRateDesc).toContain("fraction");
  });

  test("#206 — vat_post_eu_service_purchase netAmount states the kroner unit", () => {
    const schema = schemaOf("vat_post_eu_service_purchase");
    const desc: string = schema.properties?.payload?.properties?.netAmount?.description ?? "";
    expect(desc.toLowerCase()).toContain("kroner");
  });

  test("#206 — invoice_apply_payment amount states the kroner unit", () => {
    const schema = schemaOf("invoice_apply_payment");
    const desc: string = schema.properties?.payload?.properties?.amount?.description ?? "";
    expect(desc.toLowerCase()).toContain("kroner");
  });

  test("#208 — journal_post documentId description states the expense/income requirement", () => {
    const schema = schemaOf("journal_post");
    const desc: string = schema.properties?.payload?.properties?.documentId?.description ?? "";
    expect(desc.toLowerCase()).toContain("expense");
    expect(desc.toLowerCase()).toContain("income");
    expect(desc.toLowerCase()).toContain("required");
  });

  test("#210 — documents_ingest filePath is documented as server-side", () => {
    const schema = schemaOf("documents_ingest");
    const desc: string = schema.properties?.filePath?.description ?? "";
    expect(desc.toLowerCase()).toContain("server");
    // The tool description rules out an inline-content alternative.
    const tool = tools.find((t) => t.name === "documents_ingest");
    expect((tool.description ?? "").toLowerCase()).toContain("filepath");
  });
});

describe("#200 — typed schemas reject structurally invalid payloads", () => {
  test("invoice_issue rejects a payload missing the required invoiceType", async () => {
    // With the typed schema the SDK rejects this before the handler. The point
    // of #200 is that the contract is real — an agent that omits a required
    // field gets told so, instead of the call silently being accepted.
    const response = await client.send("tools/call", {
      name: "invoice_issue",
      arguments: {
        company: companyRoot,
        payload: { invoiceNumber: "X" },
        confirm: true,
      },
    });
    // The typed schema makes the SDK reject this: either a JSON-RPC error, an
    // isError result, or an error envelope — never a success.
    const structured = response.result?.structuredContent;
    const failed =
      response.error !== undefined ||
      response.result?.isError === true ||
      structured?.ok === false;
    expect(failed).toBe(true);
  });
});
