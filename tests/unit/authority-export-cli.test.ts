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
    await Bun.$`bun run src/cli.ts invoice post --company ${company} --invoice-number 2026-0001`.quiet();
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
    expect(parsed.generatedAt).toBe("2026-05-17T02:24:00.000Z");
    expect(parsed.deadlineAt).toBe("2026-06-14T02:24:00.000Z");
    expect(existsSync(parsed.manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(parsed.manifestPath, "utf8"));
    expect(manifest.packageType).toBe("authority_export");
    expect(manifest.counts.journalEntries).toBe(2);
    expect(manifest.counts.accounts).toBeGreaterThanOrEqual(10);
    expect(manifest.files.auditLog).toBe("machine-readable/audit-log.json");
    expect(manifest.appliedRules).toContain("DK-BOOKKEEPING-AUTHORITY-EXPORT-001");

    rmSync(root, { recursive: true, force: true });
  });

  test("exports a deterministic accountant handoff package with explicit trust boundaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-accountant-export-cli-"));
    const company = join(root, "company");
    const outDir = join(root, "handover");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    await Bun.$`bun run src/cli.ts invoice issue --company ${company} --input examples/full-invoice.dk.json`.quiet();
    await Bun.$`bun run src/cli.ts invoice post --company ${company} --invoice-number 2026-0001`.quiet();

    const proc = Bun.spawn([
      "bun", "run", "src/cli.ts", "system", "export-accountant",
      "--company", company,
      "--from", "2026-05-01",
      "--to", "2026-05-31",
      "--out", outDir,
      "--requested-at", "2026-05-17T02:24:00.000Z",
      "--requester", "Test accountant"
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

    const manifest = JSON.parse(readFileSync(parsed.manifestPath, "utf8"));
    expect(manifest.packageType).toBe("accountant_handoff_export");
    expect(manifest.handoffModel).toBe("local_export_package");
    expect(manifest.accessModel).toBe("no_runtime_access");
    expect(manifest.outOfScope).toContain("hosted_multi_user_access");
    expect(manifest.requester).toBe("Test accountant");

    const readme = readFileSync(join(parsed.exportDir, "README.txt"), "utf8");
    expect(readme).toContain("Primary handoff model: local export package");
    expect(readme).toContain("Out of scope: hosted reviewer/accountant access");

    rmSync(root, { recursive: true, force: true });
  });
});
