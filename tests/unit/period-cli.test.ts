import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("period close CLI", () => {
  test("closes a period and blocks later journal posting inside that period", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-periodcli-"));
    const company = join(root, "company");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();

    const closeProc = Bun.spawn([
      "bun", "run", "src/cli.ts", "period", "close",
      "--company", company,
      "--from", "2026-05-01",
      "--to", "2026-05-31",
      "--kind", "vat_quarter",
      "--reference", "SKAT-Q2-2026"
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const closeStdout = await new Response(closeProc.stdout).text();
    const closeStderr = await new Response(closeProc.stderr).text();
    const closeExitCode = await closeProc.exited;

    const postProc = Bun.spawn([
      "bun", "run", "src/cli.ts", "journal", "post",
      "--company", company,
      "--input", "examples/journal-entry.owner-contribution.json"
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, RENTEMESTER_TODAY: "2026-06-15" },
    });
    const postStdout = await new Response(postProc.stdout).text();
    const postStderr = await new Response(postProc.stderr).text();
    const postExitCode = await postProc.exited;

    rmSync(root, { recursive: true, force: true });

    expect({ closeExitCode, closeStderr }).toEqual({ closeExitCode: 0, closeStderr: "" });
    const closed = JSON.parse(closeStdout);
    expect(closed.ok).toBe(true);
    expect(closed.kind).toBe("vat_quarter");

    expect({ postExitCode, postStderr }).toEqual({ postExitCode: 1, postStderr: "" });
    const blocked = JSON.parse(postStdout);
    expect(blocked.ok).toBe(false);
    expect(blocked.errors).toContain("transactionDate 2026-05-16 falls in closed period vat_quarter 2026-05-01..2026-05-31 ref SKAT-Q2-2026");
  });
});
