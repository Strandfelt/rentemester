import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("invoice render CLI", () => {
  test("renders a deterministic PDF for an issued invoice", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-render-cli-"));
    const company = join(root, "company");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    const issue = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "issue", "--company", company, "--input", "examples/full-invoice.dk.json"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const issueStdout = await new Response(issue.stdout).text();
    const issueExitCode = await issue.exited;
    expect(issueExitCode).toBe(0);
    const issued = JSON.parse(issueStdout);
    const originalPdf = readFileSync(issued.pdfStoredPath, "latin1");
    expect(existsSync(issued.pdfStoredPath)).toBe(true);

    const render = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "render", "--company", company, "--invoice-number", issued.invoiceNumber], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(render.stdout).text();
    const stderr = await new Response(render.stderr).text();
    const exitCode = await render.exited;
    const rerenderedPdf = readFileSync(issued.pdfStoredPath, "latin1");

    rmSync(root, { recursive: true, force: true });
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.invoiceNumber).toBe(issued.invoiceNumber);
    expect(rerenderedPdf).toBe(originalPdf);
  });
});
