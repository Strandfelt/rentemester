import { describe, expect, test } from "bun:test";

describe("CLI input boundary errors", () => {
  test("fails fast when a required flag value is missing", async () => {
    const proc = Bun.spawn([
      "bun", "run", "src/cli.ts",
      "bank", "import",
      "--company",
      "--file", "examples/bank-transactions.csv",
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Flag --company requires a value");
  });

  test("prints a useful error for unknown commands", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "nonsense", "command"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(2);
    expect(stderr).toContain("Unknown command: nonsense command");
    expect(stdout).toContain("Commands:");
  });
});
