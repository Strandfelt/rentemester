// Tests: src/mcp/tools/portfolio.ts, src/mcp/tool-runtime.ts (#172)
//
// The MCP single-entry side of multi-company:
//   - company_add        — workspace-level tool wrapping core createCompany
//   - portfolio_overview — one read tool juxtaposing per-company status
//   - withCompanyDb      — resolves a workspace slug OR a raw path for `company`
//
// We exercise the tool callbacks through the registered McpServer (the same
// surface the JSON-RPC layer drives), so the registration and the runtime
// helper are both covered without spawning a child process.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPortfolioTools } from "../../src/mcp/tools/portfolio";
import { registerAccountsTools } from "../../src/mcp/tools/accounts";
import { createCompany } from "../../src/core/company";
import { listWorkspaceCompanies } from "../../src/core/workspace";
import { companyPaths } from "../../src/core/paths";
import { existsSync } from "node:fs";

function tmpWorkspace(label: string): string {
  return mkdtempSync(join(tmpdir(), `rentemester-mcp-${label}-`));
}

/**
 * Builds a fresh McpServer with a given set of tools registered, then exposes
 * a `call(name, args)` that drives a tool's registered callback and returns the
 * parsed envelope — mirroring how the JSON-RPC `tools/call` path invokes it.
 */
function harness(register: (server: McpServer) => void) {
  const server = new McpServer({ name: "portfolio-test", version: "0.0.0" });
  register(server);
  const tools = (server as any)._registeredTools as Record<
    string,
    { handler: (args: unknown, extra: unknown) => Promise<{ structuredContent: unknown }> }
  >;
  return {
    server,
    toolNames: () => Object.keys(tools),
    async call(name: string, args: unknown) {
      const tool = tools[name];
      if (!tool) throw new Error(`tool not registered: ${name}`);
      // Drive the registered handler directly — the same callback the SDK's
      // tools/call path invokes after schema validation.
      const result = await tool.handler(args, { signal: new AbortController().signal });
      return result.structuredContent as {
        ok: boolean;
        data?: any;
        errors: string[];
      };
    },
  };
}

describe("portfolio MCP tools (#172)", () => {
  test("company_add and portfolio_overview are registered", () => {
    const h = harness(registerPortfolioTools);
    const names = h.toolNames();
    expect(names).toContain("company_add");
    expect(names).toContain("portfolio_overview");
  });

  test("company_add creates a company volume inside the workspace", async () => {
    const ws = tmpWorkspace("add");
    try {
      const h = harness(registerPortfolioTools);
      const env = await h.call("company_add", {
        workspace: ws,
        name: "Acme ApS",
        cvr: "DK12345678",
      });
      expect(env.ok).toBe(true);
      expect(env.data?.slug).toBe("acme-aps");
      expect(env.data?.name).toBe("Acme ApS");
      expect(existsSync(companyPaths(join(ws, "acme-aps")).db)).toBe(true);
      // Registered in the workspace manifest.
      const companies = listWorkspaceCompanies(ws);
      expect(companies.map((c) => c.slug)).toContain("acme-aps");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("company_add honours an explicit slug", async () => {
    const ws = tmpWorkspace("add-slug");
    try {
      const h = harness(registerPortfolioTools);
      const env = await h.call("company_add", {
        workspace: ws,
        name: "Beta Holding IVS",
        slug: "beta",
      });
      expect(env.ok).toBe(true);
      expect(env.data?.slug).toBe("beta");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("company_add rejects a duplicate slug", async () => {
    const ws = tmpWorkspace("add-dup");
    try {
      createCompany(ws, { name: "Acme ApS" });
      const h = harness(registerPortfolioTools);
      const env = await h.call("company_add", { workspace: ws, name: "Acme ApS" });
      expect(env.ok).toBe(false);
      expect(env.errors.length).toBeGreaterThan(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("portfolio_overview juxtaposes per-company status across companies", async () => {
    const ws = tmpWorkspace("overview");
    try {
      createCompany(ws, { name: "Acme ApS", cvr: "DK12345678" });
      createCompany(ws, { name: "Beta IVS" });
      const h = harness(registerPortfolioTools);
      const env = await h.call("portfolio_overview", { workspace: ws });
      expect(env.ok).toBe(true);
      expect(env.data?.companyCount).toBe(2);
      const companies = env.data?.companies as Array<Record<string, unknown>>;
      expect(Array.isArray(companies)).toBe(true);
      expect(companies.map((c) => c.slug).sort()).toEqual(["acme-aps", "beta-ivs"]);
      // Each per-company row carries the juxtaposed status fields.
      for (const c of companies) {
        expect(c).toHaveProperty("name");
        expect(c).toHaveProperty("vat");
        expect(c).toHaveProperty("openReceivables");
        expect(c).toHaveProperty("backup");
        expect(c).toHaveProperty("audit");
        expect(c).toHaveProperty("openExceptions");
      }
      // Not consolidated: there is no single summed total across entities.
      expect(env.data).not.toHaveProperty("consolidatedReceivables");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("portfolio_overview on an empty workspace returns zero companies", async () => {
    const ws = tmpWorkspace("overview-empty");
    try {
      const h = harness(registerPortfolioTools);
      const env = await h.call("portfolio_overview", { workspace: ws });
      expect(env.ok).toBe(true);
      expect(env.data?.companyCount).toBe(0);
      expect(env.data?.companies).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  describe("withCompanyDb slug resolution", () => {
    test("accepts a raw company path (legacy behaviour)", async () => {
      const ws = tmpWorkspace("slug-path");
      try {
        const created = createCompany(ws, { name: "Acme ApS" });
        const h = harness(registerAccountsTools);
        const env = await h.call("accounts_list", { company: created.companyRoot });
        expect(env.ok).toBe(true);
        expect(env.data?.count).toBeGreaterThan(0);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    test("accepts a workspace slug when RENTEMESTER_WORKSPACE is set", async () => {
      const ws = tmpWorkspace("slug-resolve");
      const prev = process.env.RENTEMESTER_WORKSPACE;
      try {
        createCompany(ws, { name: "Acme ApS" });
        process.env.RENTEMESTER_WORKSPACE = ws;
        const h = harness(registerAccountsTools);
        const env = await h.call("accounts_list", { company: "acme-aps" });
        expect(env.ok).toBe(true);
        expect(env.data?.count).toBeGreaterThan(0);
      } finally {
        if (prev === undefined) delete process.env.RENTEMESTER_WORKSPACE;
        else process.env.RENTEMESTER_WORKSPACE = prev;
        rmSync(ws, { recursive: true, force: true });
      }
    });

    test("an unknown slug in a workspace returns an envelope error", async () => {
      const ws = tmpWorkspace("slug-unknown");
      const prev = process.env.RENTEMESTER_WORKSPACE;
      try {
        process.env.RENTEMESTER_WORKSPACE = ws;
        const h = harness(registerAccountsTools);
        const env = await h.call("accounts_list", { company: "no-such-company" });
        expect(env.ok).toBe(false);
        expect(env.errors.length).toBeGreaterThan(0);
      } finally {
        if (prev === undefined) delete process.env.RENTEMESTER_WORKSPACE;
        else process.env.RENTEMESTER_WORKSPACE = prev;
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });
});
