import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "../../src/core/db";
import { companyPaths } from "../../src/core/paths";

describe("init CLI", () => {
  test("stores fiscal-year and CVR company configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-init-cli-"));
    const company = join(root, "company");

    const proc = Bun.spawn([
      "bun", "run", "src/cli.ts", "init",
      "--company", company,
      "--cvr", "DK12345678",
      "--fiscal-year-start-month", "7",
      "--fiscal-year-label-strategy", "span",
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });

    const db = openDb(companyPaths(company).db);
    migrate(db);
    const row = db.query(
      `SELECT cvr, fiscal_year_start_month, fiscal_year_label_strategy
         FROM companies
        WHERE id = 1`
    ).get() as any;

    expect(row).toEqual({
      cvr: "DK12345678",
      fiscal_year_start_month: 7,
      fiscal_year_label_strategy: "span",
    });

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
