import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("authority export CLI", () => {
  test("exports a period package for authority handover", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-authority-export-cli-"));
    const company = join(root, "company");
    const outDir = join(root, "handover");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    await Bun.$`bun run src/cli.ts invoice issue --company ${company} --input examples/full-invoice.dk.json`.quiet();
    await Bun.$`bun run src/cli.ts invoice post --company ${company} --document-id 1`.quiet();
    await Bun.$`bun run src/cli.ts documents ingest --company ${company} --file examples/vendor-invoice.txt --metadata examples/vendor-invoice.metadata.json`.quiet();
    await Bun.$`bun run src/cli.ts journal post --company ${company} --input examples/journal-entry.expense.json`.quiet();

    const proc = Bun.spawn([
      "bun", "run", "src/cli.ts", "system", "export-authority",
      "--company", company,
      "--from", "2026-05-01",
      "--to", "2026-05-31",
      "--out", outDir,
      "--requested-at", "2026-05-17T02:24:00.000Z",
      "--requester", "Skattestyrelsen"
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.deadlineAt).toBe("2026-06-14T02:24:00.000Z");
    expect(existsSync(parsed.manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(parsed.manifestPath, "utf8"));
    expect(manifest.counts.journalEntries).toBe(2);
    expect(manifest.appliedRules).toContain("DK-BOOKKEEPING-AUTHORITY-EXPORT-001");

    rmSync(root, { recursive: true, force: true });
  });
});
