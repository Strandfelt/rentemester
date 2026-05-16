import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
});
