// Tests: src/cli/invoice.ts, src/cli.ts (invoice status CLI)
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("invoice status CLI", () => {
  test("shows overdue classification at a chosen as-of date", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-status-cli-"));
    const company = join(root, "company");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    await Bun.$`bun run src/cli.ts invoice issue --company ${company} --input examples/full-invoice.dk.json`.quiet();

    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "status", "--company", company, "--invoice-number", "2026-0001", "--as-of", "2026-06-20"], {
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
    expect(parsed.effectiveDueDate).toBe("2026-06-15");
    expect(parsed.isOverdue).toBe(true);
    expect(parsed.overdueDays).toBe(5);
  });
});
