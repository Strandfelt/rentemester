// Tests: src/server/data.ts — portfolio aggregation across workspace companies.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPortfolioOverview } from "../../src/server/data";
import { handleRequest } from "../../src/server/router";
import type { ServerConfig } from "../../src/server/config";
import { createCompany } from "../../src/core/company";
import { initWorkspace } from "../../src/core/workspace";

function tmpRoot(label: string) {
  return mkdtempSync(join(tmpdir(), `rentemester-${label}-`));
}

function config(workspaceRoot: string): ServerConfig {
  return { host: "127.0.0.1", port: 0, authRequired: false, authToken: null, workspaceRoot };
}

describe("portfolio aggregation", () => {
  test("an empty workspace yields zero companies and zero totals", () => {
    const ws = tmpRoot("pf-empty");
    try {
      initWorkspace(ws);
      const overview = buildPortfolioOverview(ws, "2026-05-20");
      expect(overview.companyCount).toBe(0);
      expect(overview.companies).toEqual([]);
      expect(overview.totals.openInvoiceCount).toBe(0);
      expect(overview.totals.openInvoiceTotal).toBe(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("produces one summary per company", () => {
    const ws = tmpRoot("pf-summaries");
    try {
      initWorkspace(ws);
      createCompany(ws, { name: "Acme ApS" });
      createCompany(ws, { name: "Beta IVS" });
      const overview = buildPortfolioOverview(ws, "2026-05-20");
      expect(overview.companyCount).toBe(2);
      const slugs = overview.companies.map((c) => c.slug).sort();
      expect(slugs).toEqual(["acme-aps", "beta-ivs"]);
      for (const c of overview.companies) {
        expect(c.openInvoiceCount).toBe(0);
        expect(c.ledgerMissing).toBe(false);
        expect(c).toHaveProperty("netVatPayable");
        expect(c).toHaveProperty("auditChainOk");
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("totals are the sum of per-company figures", () => {
    const ws = tmpRoot("pf-totals");
    try {
      initWorkspace(ws);
      createCompany(ws, { name: "Acme ApS" });
      createCompany(ws, { name: "Beta IVS" });
      const overview = buildPortfolioOverview(ws, "2026-05-20");
      const sum = overview.companies.reduce((a, c) => a + c.openInvoiceCount, 0);
      expect(overview.totals.openInvoiceCount).toBe(sum);
      const vatSum = overview.companies.reduce((a, c) => a + c.netVatPayable, 0);
      expect(overview.totals.netVatPayable).toBeCloseTo(vatSum, 6);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("GET /api/portfolio surfaces the aggregation", async () => {
    const ws = tmpRoot("pf-endpoint");
    try {
      initWorkspace(ws);
      createCompany(ws, { name: "Acme ApS" });
      const res = await handleRequest(
        new Request("http://localhost/api/portfolio?asOf=2026-05-20"),
        config(ws),
      );
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.portfolio.companyCount).toBe(1);
      expect(body.portfolio.asOf).toBe("2026-05-20");
      expect(body.portfolio.companies[0].slug).toBe("acme-aps");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
