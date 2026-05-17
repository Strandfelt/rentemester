import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../../src/cli-args";

describe("CLI arg parser", () => {
  test("keeps repeated raw values attached to their own flags", () => {
    const parsed = parseCliArgs([
      "bun", "src/cli.ts",
      "invoice", "issue",
      "--company", "/tmp/smoke",
      "--input", "/tmp/smoke",
    ]);

    expect(parsed.errors).toEqual([]);
    expect(parsed.positionals).toEqual(["invoice", "issue"]);
    expect(parsed.flags.get("--company")).toBe("/tmp/smoke");
    expect(parsed.flags.get("--input")).toBe("/tmp/smoke");
  });

  test("reports missing flag values instead of silently consuming the next flag", () => {
    const parsed = parseCliArgs([
      "bun", "src/cli.ts",
      "bank", "import",
      "--company",
      "--file", "examples/bank-transactions.csv",
    ]);

    expect(parsed.errors).toContain("Flag --company requires a value");
    expect(parsed.flags.get("--file")).toBe("examples/bank-transactions.csv");
  });
});
