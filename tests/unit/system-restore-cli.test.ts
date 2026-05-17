import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("system restore CLI", () => {
  test("restores a created backup into a fresh company folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-restore-cli-"));
    const company = join(root, "company");
    const restored = join(root, "restored-company");
    const backupDir = join(company, "backups", "backup-20260517T023900Z");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    await Bun.$`bun run src/cli.ts documents ingest --company ${company} --file examples/vendor-invoice.txt --metadata examples/vendor-invoice.metadata.json`.quiet();
    await Bun.$`bun run src/cli.ts journal post --company ${company} --input examples/journal-entry.expense.json`.quiet();
    await Bun.$`bun run src/cli.ts system backup --company ${company} --at 2026-05-17T02:39:00.000Z`.quiet();

    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "system", "restore-backup", "--backup-dir", backupDir, "--target-company", restored], {
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
    expect(parsed.backupId).toBe("backup-20260517T023900Z");
    expect(existsSync(join(restored, "data", "ledger.sqlite"))).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });
});
