// Tests: src/server/router.ts, src/server/auth.ts, src/server/errors.ts,
// src/server/config.ts — endpoint contracts, the auth seam, and safe errors.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRequest } from "../../src/server/router";
import { resolveServerConfig, type ServerConfig } from "../../src/server/config";
import { createCompany } from "../../src/core/company";
import { initWorkspace, companyRootForSlug } from "../../src/core/workspace";
import { companyPaths } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { postJournalEntry } from "../../src/core/ledger";
import { ingestDocument } from "../../src/core/documents";

function tmpRoot(label: string) {
  return mkdtempSync(join(tmpdir(), `rentemester-${label}-`));
}

/** A workspace with the named companies created in it. */
function makeWorkspace(label: string, companyNames: string[] = []) {
  const root = tmpRoot(label);
  initWorkspace(root);
  for (const name of companyNames) createCompany(root, { name });
  return root;
}

function config(overrides: Partial<ServerConfig> & { workspaceRoot: string }): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    authRequired: false,
    authToken: null,
    ...overrides,
  };
}

async function get(cfg: ServerConfig, path: string, init?: RequestInit) {
  const res = await handleRequest(new Request(`http://localhost${path}`, init), cfg);
  const body = await res.json();
  return { status: res.status, body };
}

describe("cockpit API — config", () => {
  test("defaults to the localhost bind address", () => {
    const cfg = resolveServerConfig({
      workspaceRoot: "/tmp/ws",
      env: {},
    });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(4319);
    expect(cfg.authRequired).toBe(false);
  });

  test("bind address is config-driven via env", () => {
    const cfg = resolveServerConfig({
      workspaceRoot: "/tmp/ws",
      env: { RENTEMESTER_APP_HOST: "0.0.0.0", RENTEMESTER_APP_PORT: "9000" },
    });
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.port).toBe(9000);
  });

  test("rejects a non-numeric port", () => {
    expect(() =>
      resolveServerConfig({ workspaceRoot: "/tmp/ws", env: { RENTEMESTER_APP_PORT: "abc" } }),
    ).toThrow(/RENTEMESTER_APP_PORT/);
  });

  test("requires a workspace root", () => {
    expect(() => resolveServerConfig({ env: {} })).toThrow(/workspace/);
  });
});

describe("cockpit API — auth seam", () => {
  test("phase 1 (localhost-trusted) is a pass-through", async () => {
    const ws = makeWorkspace("auth-passthrough");
    try {
      const res = await get(config({ workspaceRoot: ws }), "/api/health");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("when auth is enabled the seam rejects an unauthenticated request", async () => {
    const ws = makeWorkspace("auth-reject");
    try {
      const cfg = config({ workspaceRoot: ws, authRequired: true, authToken: "s3cret" });
      const res = await get(cfg, "/api/health");
      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("unauthorized");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("when auth is enabled a valid bearer token passes the seam", async () => {
    const ws = makeWorkspace("auth-accept");
    try {
      const cfg = config({ workspaceRoot: ws, authRequired: true, authToken: "s3cret" });
      const res = await get(cfg, "/api/health", {
        headers: { authorization: "Bearer s3cret" },
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("an invalid bearer token is rejected", async () => {
    const ws = makeWorkspace("auth-badtoken");
    try {
      const cfg = config({ workspaceRoot: ws, authRequired: true, authToken: "s3cret" });
      const res = await get(cfg, "/api/health", {
        headers: { authorization: "Bearer wrong" },
      });
      expect(res.status).toBe(401);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("cockpit API — endpoint contracts", () => {
  test("GET /api/health reports the service", async () => {
    const ws = makeWorkspace("ep-health");
    try {
      const res = await get(config({ workspaceRoot: ws }), "/api/health");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, service: "rentemester-cockpit" });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("GET /api/companies lists workspace companies", async () => {
    const ws = makeWorkspace("ep-companies", ["Acme ApS", "Beta IVS"]);
    try {
      const res = await get(config({ workspaceRoot: ws }), "/api/companies");
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      const slugs = res.body.companies.map((c: any) => c.slug).sort();
      expect(slugs).toEqual(["acme-aps", "beta-ivs"]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("GET /api/companies/:slug/dashboard returns dashboard data", async () => {
    const ws = makeWorkspace("ep-dashboard", ["Acme ApS"]);
    try {
      const res = await get(config({ workspaceRoot: ws }), "/api/companies/acme-aps/dashboard");
      expect(res.status).toBe(200);
      expect(res.body.dashboard.slug).toBe("acme-aps");
      expect(res.body.dashboard.company.name).toBe("Acme ApS");
      expect(res.body.dashboard.invoices.count).toBe(0);
      expect(res.body.dashboard).toHaveProperty("vat");
      expect(res.body.dashboard).toHaveProperty("audit");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("GET dashboard for an unknown slug is a safe 404", async () => {
    const ws = makeWorkspace("ep-dashboard-404", ["Acme ApS"]);
    try {
      const res = await get(config({ workspaceRoot: ws }), "/api/companies/ghost/dashboard");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("an unknown endpoint is a safe 404", async () => {
    const ws = makeWorkspace("ep-unknown");
    try {
      const res = await get(config({ workspaceRoot: ws }), "/api/nope");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("a wrong method on a known route is 405", async () => {
    const ws = makeWorkspace("ep-405");
    try {
      const res = await get(config({ workspaceRoot: ws }), "/api/portfolio", {
        method: "DELETE",
      });
      expect(res.status).toBe(405);
      expect(res.body.error.code).toBe("method_not_allowed");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("an invalid asOf query value is rejected with a safe 400", async () => {
    const ws = makeWorkspace("ep-badasof");
    try {
      const res = await get(config({ workspaceRoot: ws }), "/api/portfolio?asOf=not-a-date");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("error responses never leak a filesystem path", async () => {
    const ws = makeWorkspace("ep-noleak", ["Acme ApS"]);
    try {
      const res = await get(config({ workspaceRoot: ws }), "/api/companies/ghost/dashboard");
      expect(JSON.stringify(res.body)).not.toContain(ws);
      expect(JSON.stringify(res.body)).not.toContain("/");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

/** Posts one balanced entry into a workspace company's ledger. */
function postEntry(ws: string, slug: string, transactionDate: string) {
  const dbPath = companyPaths(companyRootForSlug(ws, slug)).db;
  const db = openDb(dbPath);
  try {
    migrate(db);
    // Two asset accounts keep the entry document-free (no income/expense line).
    const res = postJournalEntry(db, {
      transactionDate,
      text: "Test posting",
      lines: [
        { accountNo: "1100", debitAmount: 100 },
        { accountNo: "2000", creditAmount: 100 },
      ],
    });
    if (!res.ok) throw new Error(res.errors.join("; "));
  } finally {
    db.close();
  }
}

describe("cockpit API — fiscal years (GET /api/companies/:slug/fiscal-years)", () => {
  test("an empty ledger has no fiscal years", async () => {
    const ws = makeWorkspace("fy-empty", ["Acme ApS"]);
    try {
      const res = await get(config({ workspaceRoot: ws }), "/api/companies/acme-aps/fiscal-years");
      expect(res.status).toBe(200);
      expect(res.body.fiscalYears.slug).toBe("acme-aps");
      expect(res.body.fiscalYears.years).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("a posted entry surfaces its fiscal year as a live year", async () => {
    const ws = makeWorkspace("fy-live", ["Acme ApS"]);
    try {
      postEntry(ws, "acme-aps", "2026-03-15");
      const res = await get(config({ workspaceRoot: ws }), "/api/companies/acme-aps/fiscal-years");
      expect(res.status).toBe(200);
      expect(res.body.fiscalYears.years).toEqual([
        { label: "2026", start: "2026-01-01", end: "2026-12-31", source: "live" },
      ]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("multiple years are returned newest-first", async () => {
    const ws = makeWorkspace("fy-multi", ["Acme ApS"]);
    try {
      postEntry(ws, "acme-aps", "2025-06-01");
      postEntry(ws, "acme-aps", "2026-02-01");
      const res = await get(config({ workspaceRoot: ws }), "/api/companies/acme-aps/fiscal-years");
      expect(res.body.fiscalYears.years.map((y: any) => y.label)).toEqual(["2026", "2025"]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("fiscal-years for an unknown slug is a safe 404", async () => {
    const ws = makeWorkspace("fy-404", ["Acme ApS"]);
    try {
      const res = await get(config({ workspaceRoot: ws }), "/api/companies/ghost/fiscal-years");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

/**
 * Posts a profit-and-loss pair into a workspace company's ledger: a sale that
 * credits income account `1000` (VAT code `DK_SALE_25`) and a purchase that
 * debits expense account `3000` (VAT code `DK_PURCHASE_25`). Both are 25%-VAT
 * standard-rated, so the overview's VAT block is exercised. The cash side runs
 * over bank account `2000`. Income/expense lines require a document, so a
 * minimal one is ingested first.
 */
function postPnlEntry(
  ws: string,
  slug: string,
  transactionDate: string,
  income: number,
  expense: number,
) {
  const companyRoot = companyRootForSlug(ws, slug);
  const dbPath = companyPaths(companyRoot).db;
  const db = openDb(dbPath);
  try {
    migrate(db);
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-ov-inbox-"));
    const sourceFile = join(inbox, "doc.txt");
    writeFileSync(sourceFile, "Bilag\n1 DKK\n");
    const doc = ingestDocument(db, companyRoot, sourceFile, {
      source: "email",
      issueDate: transactionDate,
      invoiceNo: `OV-${transactionDate}`,
      deliveryDescription: "Overblik testbilag",
      amountIncVat: 1,
      currency: "DKK",
      sender: { name: "Leverandør ApS", address: "Vej 1", vatOrCvr: "DK11223344" },
      recipient: { name: "Acme ApS", address: "Vej 2", vatOrCvr: "DK12345678" },
      vatAmount: 0,
      paymentDetails: "Bankoverførsel",
    });
    if (!doc.ok) throw new Error("doc ingest failed: " + (doc.errors ?? []).join("; "));

    if (income > 0) {
      const sale = postJournalEntry(db, {
        transactionDate,
        text: "Overblik salg",
        documentId: doc.documentId,
        lines: [
          { accountNo: "2000", debitAmount: income * 1.25 },
          { accountNo: "1000", creditAmount: income, vatCode: "DK_SALE_25" },
          { accountNo: "1200", creditAmount: income * 0.25 },
        ],
      });
      if (!sale.ok) throw new Error("sale post failed: " + sale.errors.join("; "));
    }
    if (expense > 0) {
      const purchase = postJournalEntry(db, {
        transactionDate,
        text: "Overblik køb",
        documentId: doc.documentId,
        lines: [
          { accountNo: "3000", debitAmount: expense, vatCode: "DK_PURCHASE_25" },
          { accountNo: "4000", debitAmount: expense * 0.25 },
          { accountNo: "2000", creditAmount: expense * 1.25 },
        ],
      });
      if (!purchase.ok) throw new Error("purchase post failed: " + purchase.errors.join("; "));
    }
  } finally {
    db.close();
  }
}

describe("cockpit API — overview (GET /api/companies/:slug/overview)", () => {
  test("returns the P&L, bank and VAT blocks for the live year", async () => {
    const ws = makeWorkspace("ov-live", ["Acme ApS"]);
    try {
      postPnlEntry(ws, "acme-aps", "2026-03-15", 1000, 400);
      const res = await get(
        config({ workspaceRoot: ws }),
        "/api/companies/acme-aps/overview?year=2026",
      );
      expect(res.status).toBe(200);
      expect(res.body.overview.slug).toBe("acme-aps");
      expect(res.body.overview.selectedYear).toBe("2026");
      expect(res.body.overview.archived).toBe(false);
      expect(res.body.overview.profitAndLoss.omsaetning).toBe(1000);
      expect(res.body.overview.profitAndLoss.udgifter).toBe(400);
      expect(res.body.overview.profitAndLoss.resultat).toBe(600);
      expect(res.body.overview.profitAndLoss.months).toHaveLength(12);
      expect(res.body.overview.profitAndLoss.months[2].income).toBe(1000);
      expect(res.body.overview.profitAndLoss.months[2].expense).toBe(400);
      // VAT: 25% of the 1000 sales base / the 400 purchase base.
      expect(res.body.overview.vat.outputVat).toBe(250);
      expect(res.body.overview.vat.inputVat).toBe(100);
      expect(res.body.overview.vat.payable).toBe(150);
      expect(res.body.overview.vat.periodLabel).toBe("1. halvår 2026");
      // Bank account 2000 nets +1250 (sale) −500 (purchase) = 750.
      expect(res.body.overview.bank.balance).toBe(750);
      expect(res.body.overview.recentEntries.length).toBeGreaterThan(0);
      expect(res.body.overview.fiscalYears[0].label).toBe("2026");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("defaults to the most recent live year when year is omitted", async () => {
    const ws = makeWorkspace("ov-default", ["Acme ApS"]);
    try {
      postPnlEntry(ws, "acme-aps", "2026-02-01", 500, 100);
      const res = await get(
        config({ workspaceRoot: ws }),
        "/api/companies/acme-aps/overview",
      );
      expect(res.status).toBe(200);
      expect(res.body.overview.selectedYear).toBe("2026");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("an invalid year query value is a safe 400", async () => {
    const ws = makeWorkspace("ov-badyear", ["Acme ApS"]);
    try {
      const res = await get(
        config({ workspaceRoot: ws }),
        "/api/companies/acme-aps/overview?year=20xx",
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("overview for an unknown slug is a safe 404", async () => {
    const ws = makeWorkspace("ov-404", ["Acme ApS"]);
    try {
      const res = await get(
        config({ workspaceRoot: ws }),
        "/api/companies/ghost/overview",
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("cockpit API — company onboarding (POST /api/companies)", () => {
  test("creates a new company in the workspace", async () => {
    const ws = makeWorkspace("add-create");
    try {
      const res = await get(config({ workspaceRoot: ws }), "/api/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Gamma ApS", cvr: "DK12345678" }),
      });
      expect(res.status).toBe(201);
      expect(res.body.company.slug).toBe("gamma-aps");

      const list = await get(config({ workspaceRoot: ws }), "/api/companies");
      expect(list.body.companies.map((c: any) => c.slug)).toContain("gamma-aps");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("a missing name is a safe 400", async () => {
    const ws = makeWorkspace("add-noname");
    try {
      const res = await get(config({ workspaceRoot: ws }), "/api/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("a duplicate slug is a conflict with no path leak", async () => {
    const ws = makeWorkspace("add-dup", ["Acme ApS"]);
    try {
      const res = await get(config({ workspaceRoot: ws }), "/api/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme ApS" }),
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("conflict");
      expect(JSON.stringify(res.body)).not.toContain(ws);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("a malformed JSON body is a safe 400", async () => {
    const ws = makeWorkspace("add-badjson");
    try {
      const res = await get(config({ workspaceRoot: ws }), "/api/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("POST onboarding is gated by the auth seam too", async () => {
    const ws = makeWorkspace("add-auth");
    try {
      const cfg = config({ workspaceRoot: ws, authRequired: true, authToken: "s3cret" });
      const res = await get(cfg, "/api/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Delta ApS" }),
      });
      expect(res.status).toBe(401);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
