import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("customer validate-vat CLI", () => {
  test("validates an EU VAT number and caches the result", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-vies-cli-"));
    const company = join(root, "company");
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ valid: true, name: "EU Kunde GmbH", address: "Berlin" });
      }
    });
    const env = { ...process.env, RENTEMESTER_VIES_ENDPOINT: `http://127.0.0.1:${server.port}/check` };

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();

    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "customer", "validate-vat", "--company", company, "--cvr", "DE123456789"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    server.stop(true);
    rmSync(root, { recursive: true, force: true });
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.validation.normalized).toBe("DE123456789");
    expect(parsed.validation.valid).toBe(true);
  });
});
