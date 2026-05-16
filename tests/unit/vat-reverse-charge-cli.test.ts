import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("EU service reverse-charge CLI", () => {
  test("posts reverse-charge purchase from input json", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-rc-cli-"));
    const company = join(root, "company");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    await Bun.$`bun run src/cli.ts documents ingest --company ${company} --file examples/eu-service-invoice.txt --metadata examples/eu-service-invoice.metadata.json`.quiet();

    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "vat", "post-eu-service-purchase", "--company", company, "--input", "examples/eu-service-purchase.json"], {
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
    expect(parsed.appliedRules).toContain("DK-VAT-REVERSE-CHARGE-001");
  });
});
