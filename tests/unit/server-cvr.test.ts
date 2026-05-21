// Tests: src/server/router.ts, src/server/data.ts — the CVR cockpit endpoints
// GET /api/companies/:slug/company and POST /api/companies/:slug/sync-cvr.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRequest } from "../../src/server/router";
import type { ServerConfig } from "../../src/server/config";
import { createCompany } from "../../src/core/company";
import { initWorkspace } from "../../src/core/workspace";

function config(workspaceRoot: string): ServerConfig {
  return { host: "127.0.0.1", port: 0, authRequired: false, authToken: null, workspaceRoot };
}

async function call(cfg: ServerConfig, path: string, init?: RequestInit) {
  const res = await handleRequest(new Request(`http://localhost${path}`, init), cfg);
  return { status: res.status, body: await res.json() };
}

describe("cockpit API — CVR endpoints", () => {
  test("GET /api/companies/:slug/company returns the full settings row", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-srv-cvr-"));
    initWorkspace(root);
    createCompany(root, { name: "Acme", cvr: "DK12345678" });
    const cfg = config(root);

    const { status, body } = await call(cfg, "/api/companies/acme/company");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.company.cvr).toBe("DK12345678");
    // The CVR stamdata columns exist and are null until a sync runs.
    expect(body.company.address).toBeNull();
    expect(body.company.cvrSyncedAt).toBeNull();

    rmSync(root, { recursive: true, force: true });
  });

  test("GET .../company for an unknown slug is a safe 404", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-srv-cvr-404-"));
    initWorkspace(root);
    const { status, body } = await call(config(root), "/api/companies/ghost/company");
    expect(status).toBe(404);
    expect(body.ok).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("a GET on the sync-cvr route is 405 — it is POST-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-srv-cvr-405-"));
    initWorkspace(root);
    createCompany(root, { name: "Acme" });
    const { status } = await call(config(root), "/api/companies/acme/sync-cvr");
    expect(status).toBe(405);
    rmSync(root, { recursive: true, force: true });
  });

  test("POST .../sync-cvr without a registered CVR reports the failure inside sync.ok", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-srv-cvr-nocvr-"));
    initWorkspace(root);
    createCompany(root, { name: "Acme" }); // no CVR number

    const { status, body } = await call(config(root), "/api/companies/acme/sync-cvr", {
      method: "POST",
    });
    // The HTTP call succeeds; the CVR failure is carried structurally.
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sync.ok).toBe(false);
    expect(body.sync.errors[0]).toContain("CVR-nummer");

    rmSync(root, { recursive: true, force: true });
  });
});
