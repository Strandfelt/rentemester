// Tests: src/cli/gdpr.ts, src/cli.ts (GDPR export/erase CLI — #184)
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RENTEMESTER_ACTOR: undefined, USER: "gdpr-test" },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("GDPR CLI", () => {
  test("exports a customer's personal data and then erases it once unretained", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-gdpr-cli-"));
    const company = join(root, "company");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    const created = await runCli([
      "customer", "create", "--company", company,
      "--name", "GDPR Kunde", "--cvr", "DK90909090",
      "--email", "gdpr-kunde@example.com", "--address", "Indsigtsvej 1, 1000 København K",
    ]);
    expect(created.exitCode).toBe(0);

    const exported = await runCli([
      "gdpr", "export", "--company", company, "--cvr", "DK90909090",
    ]);
    expect(exported.exitCode).toBe(0);
    const exportJson = JSON.parse(exported.stdout);
    expect(exportJson.ok).toBe(true);
    expect(exportJson.records.length).toBe(1);
    expect(exportJson.records[0].personalData.email).toBe("gdpr-kunde@example.com");

    // No linked bookkeeping records, so a far-future date allows erasure.
    const erased = await runCli([
      "gdpr", "erase", "--company", company, "--cvr", "DK90909090", "--as-of", "2099-01-01",
    ]);
    expect(erased.exitCode).toBe(0);
    const eraseJson = JSON.parse(erased.stdout);
    expect(eraseJson.ok).toBe(true);
    expect(eraseJson.erasedCount).toBeGreaterThan(0);
    expect(eraseJson.refusedCount).toBe(0);

    const reExported = await runCli([
      "gdpr", "export", "--company", company, "--cvr", "DK90909090", "--as-of", "2099-01-01",
    ]);
    rmSync(root, { recursive: true, force: true });
    expect(reExported.exitCode).toBe(0);
    const reExportJson = JSON.parse(reExported.stdout);
    expect(reExportJson.records[0].erased).toBe(true);
    expect(reExportJson.records[0].personalData.email).toBeNull();
  });

  test("export requires a subject identifier", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-gdpr-cli-nosubj-"));
    const company = join(root, "company");
    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();

    const exported = await runCli(["gdpr", "export", "--company", company]);
    rmSync(root, { recursive: true, force: true });
    expect(exported.exitCode).toBe(1);
    expect(JSON.parse(exported.stdout)).toMatchObject({ ok: false });
  });
});
