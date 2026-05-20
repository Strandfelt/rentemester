// Tests: src/cli-meta.ts, src/cli.ts (CLI help formatting)
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("CLI help, examples, and human formatting", () => {
  test("prints per-command help for invoice issue", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "issue", "--help"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout).toContain("rentemester invoice issue --company <path> --input <file.json>");
    expect(stdout).toContain("invoiceType");
    expect(stdout).toContain("rentemester invoice issue --example > faktura.json");
  });

  test("prints a valid example payload for invoice issue", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "issue", "--example"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const parsed = JSON.parse(stdout);
    expect(parsed.invoiceType).toBe("full");
    expect(parsed.currency).toBe("DKK");
  });

  test("suggests the right flag name for command-local typos", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "issue", "--companies", "/tmp/company", "--input", "examples/full-invoice.dk.json"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Unknown flag --companies for invoice issue. Did you mean --company?");
  });

  test("keeps JSON as the default for piped success output", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "validate", "--input", "examples/full-invoice.dk.json"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout).ok).toBe(true);
  });

  test("renders human success output when requested", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "validate", "--input", "examples/full-invoice.dk.json", "--format", "human"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout).toContain("✔");
    expect(stdout).not.toContain('"ok"');
  });

  test("renders human error output when requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rentemester-cli-human-"));
    const file = join(dir, "bad-invoice.json");
    writeFileSync(file, JSON.stringify({ invoiceType: "full", currency: "DKK" }, null, 2));

    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "validate", "--input", file, "--format", "human"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    rmSync(dir, { recursive: true, force: true });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("✘");
    expect(stderr).toContain("issueDate must be present in YYYY-MM-DD format");
    expect(stderr).not.toContain('"errors"');
  });
});
