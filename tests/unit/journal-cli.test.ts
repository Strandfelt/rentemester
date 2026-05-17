import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "../../src/core/db";
import { companyPaths } from "../../src/core/paths";

describe("journal post CLI", () => {
  test("posts a valid journal entry against an ingested document", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journalcli-"));
    const company = join(root, "company");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    await Bun.$`bun run src/cli.ts documents ingest --company ${company} --file examples/vendor-invoice.txt --metadata examples/vendor-invoice.metadata.json`.quiet();

    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "journal", "post", "--company", company, "--input", "examples/journal-entry.expense.json"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    rmSync(root, { recursive: true, force: true });
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.entryNo).toContain("2026-");
  });

  test("threads explicit actor attribution into journal entries and audit log", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journalcli-actor-"));
    const company = join(root, "company");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    await Bun.$`bun run src/cli.ts documents ingest --company ${company} --file examples/vendor-invoice.txt --metadata examples/vendor-invoice.metadata.json`.quiet();

    const proc = Bun.spawn([
      "bun", "run", "src/cli.ts", "journal", "post",
      "--company", company,
      "--input", "examples/journal-entry.expense.json",
      "--actor", "agent:freja",
      "--actor-via", "openclaw"
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    const db = openDb(companyPaths(company).db);
    migrate(db);
    const entry = db.query("SELECT created_by, created_by_program FROM journal_entries ORDER BY id DESC LIMIT 1").get() as any;
    const audit = db.query("SELECT actor FROM audit_log WHERE event_type = 'journal_post' ORDER BY id DESC LIMIT 1").get() as any;
    db.close();

    rmSync(root, { recursive: true, force: true });
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(entry).toEqual({ created_by: "agent:freja", created_by_program: "openclaw" });
    expect(audit.actor).toBe("agent:freja via openclaw");
  });
});
