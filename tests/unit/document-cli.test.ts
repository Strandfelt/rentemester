import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("documents ingest CLI", () => {
  test("returns exit code 0 for valid metadata and file", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-doccli-"));
    const company = join(root, "company");
    const file = join(root, "invoice.txt");
    const metadata = join(root, "metadata.json");

    writeFileSync(file, "Invoice 1002\n1250 DKK\n");
    writeFileSync(metadata, JSON.stringify({
      source: "email",
      issueDate: "2026-05-16",
      invoiceNo: "INV-1002",
      deliveryDescription: "Bogføring og momsafstemning",
      amountIncVat: 1250,
      currency: "DKK",
      sender: { name: "Leverandør ApS", address: "Sælgervej 1, 2100 København Ø", vatOrCvr: "DK11223344" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1, 2100 København Ø", vatOrCvr: "DK12345678" },
      vatAmount: 250,
      paymentDetails: "Bankoverførsel"
    }, null, 2));

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "documents", "ingest", "--company", company, "--file", file, "--metadata", metadata], {
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
    expect(parsed.documentNo).toContain("DOC-");
  });
});
