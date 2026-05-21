// Tests: src/cli-format.ts, src/cli/vat.ts, src/cli/invoice.ts (#211 human output)
//
// The read/report commands render Danish kroner-og-øre text under
// `--format human`, while `--format json` stays byte-stable for agents.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatKroner } from "../../src/cli-format";

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("formatKroner", () => {
  test("renders DKK amounts as Danish kroner-og-øre", () => {
    expect(formatKroner(38.3)).toBe("38,30 kr.");
    expect(formatKroner(0)).toBe("0,00 kr.");
    expect(formatKroner(1234.5)).toBe("1.234,50 kr.");
    expect(formatKroner(-250)).toBe("-250,00 kr.");
    expect(formatKroner(1234567.89)).toBe("1.234.567,89 kr.");
  });

  test("renders missing or non-finite input as an em dash", () => {
    expect(formatKroner(null)).toBe("—");
    expect(formatKroner(undefined)).toBe("—");
    expect(formatKroner(Number.NaN)).toBe("—");
  });
});

describe("vat report human output (#211)", () => {
  test("renders the VAT report in Danish kroner-og-øre", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-vat-human-"));
    const company = join(root, "company");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    await Bun.$`bun run src/cli.ts documents ingest --company ${company} --file examples/vendor-invoice.txt --metadata examples/vendor-invoice.metadata.json`.quiet();
    await Bun.$`bun run src/cli.ts journal post --company ${company} --input examples/journal-entry.expense.json`.quiet();

    const human = await runCli([
      "vat", "report", "--company", company,
      "--from", "2026-05-01", "--to", "2026-05-31",
      "--format", "human",
    ]);
    const jsonRun = await runCli([
      "vat", "report", "--company", company,
      "--from", "2026-05-01", "--to", "2026-05-31",
      "--format", "json",
    ]);

    rmSync(root, { recursive: true, force: true });

    expect(human.exitCode).toBe(0);
    expect(human.stderr).toBe("");
    // Danish prose, no raw JSON field names.
    expect(human.stdout).toContain("Momsrapport for perioden 2026-05-01 til 2026-05-31");
    expect(human.stdout).not.toContain("netVatPayable");
    expect(human.stdout).not.toContain("outputVat");
    expect(human.stdout).not.toContain("{");
    // This period has 250,00 kr. input VAT and no output VAT, so the company
    // has money to its credit.
    expect(human.stdout).toContain("Du har 250,00 kr. til gode i moms for perioden.");
    expect(human.stdout).toContain("Købsmoms (indgående moms):");
    expect(human.stdout).toContain("250,00 kr.");

    // The json path stays byte-stable: exactly the JSON payload.
    const parsed = JSON.parse(jsonRun.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.inputVat).toBe(250);
    expect(parsed.netVatPayable).toBe(-250);
  });
});

describe("invoice status human output (#211)", () => {
  test("renders the invoice status in Danish kroner-og-øre", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-status-human-"));
    const company = join(root, "company");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    await Bun.$`bun run src/cli.ts invoice issue --company ${company} --input examples/full-invoice.dk.json`.quiet();

    const human = await runCli([
      "invoice", "status", "--company", company,
      "--invoice-number", "2026-0001", "--as-of", "2026-06-20",
      "--format", "human",
    ]);
    const jsonRun = await runCli([
      "invoice", "status", "--company", company,
      "--invoice-number", "2026-0001", "--as-of", "2026-06-20",
      "--format", "json",
    ]);

    rmSync(root, { recursive: true, force: true });

    expect(human.exitCode).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toContain("Status for faktura 2026-0001");
    expect(human.stdout).not.toContain("openBalance");
    expect(human.stdout).not.toContain("isOverdue");
    expect(human.stdout).not.toContain("{");
    expect(human.stdout).toContain("Fakturaen er forfalden — 5 dage over forfaldsdato.");
    expect(human.stdout).toContain("Åben saldo:");
    expect(human.stdout).toMatch(/\d+,\d{2} kr\./);

    // The json path stays byte-stable.
    const parsed = JSON.parse(jsonRun.stdout);
    expect(parsed.effectiveDueDate).toBe("2026-06-15");
    expect(parsed.isOverdue).toBe(true);
    expect(parsed.overdueDays).toBe(5);
  });
});
