import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildIssuedInvoicePdf } from "../../src/core/invoice-pdf";

describe("invoice PDF rendering", () => {
  test("paginates long invoices without dropping totals or the reverse-charge note", () => {
    const lines = Array.from({ length: 80 }, (_, i) => ({
      description: `Linje ${i + 1}`,
      quantity: 1,
      unitPriceExVat: 100,
      lineTotalExVat: 100,
    }));
    const pdf = buildIssuedInvoicePdf({
      invoiceNumber: "2026-9999",
      issueDate: "2026-05-16",
      dueDate: "2026-06-15",
      currency: "DKK",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9", vatOrCvr: "DK87654321" },
      lines,
      totals: { netAmount: 8000, vatAmount: 2000, grossAmount: 10000 },
      reverseChargeNote: "Omvendt betalingspligt - koeber afregner moms",
    } as any);
    const text = Buffer.from(pdf).toString("latin1");

    // Trailing legally-required content must survive into the rendered PDF.
    expect(text).toContain("Total: 10000.00 DKK");
    expect(text).toContain("Omvendt betalingspligt");
    // Pagination produces more than one page object.
    const count = text.match(/\/Count (\d+)/);
    expect(count).not.toBeNull();
    expect(Number(count![1])).toBeGreaterThan(1);
  });
});

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
