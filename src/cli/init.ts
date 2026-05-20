import { existsSync } from "node:fs";
import { companyPaths } from "../core/paths";
import { initialiseCompanyVolume } from "../core/company";
import type { CommandDispatch } from "../cli-dispatch";

export function register(dispatch: CommandDispatch): void {
  dispatch.on("init", null, (ctx) => {
    const root = ctx.companyRoot();
    try {
      const result = initialiseCompanyVolume(root, {
        cvr: ctx.arg("--cvr"),
        fiscalYearStartMonth: ctx.arg("--fiscal-year-start-month"),
        fiscalYearLabelStrategy: ctx.arg("--fiscal-year-label-strategy"),
      });
      console.log(`Initialized Rentemester company at ${root}`);
      console.log(`Ledger: ${result.dbPath}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    }
  });

  dispatch.on("system", "healthcheck", (ctx) => {
    const p = companyPaths(ctx.companyRoot());
    const checks: Array<[string, boolean]> = [
      ["company_root", existsSync(p.root)],
      ["data_dir", existsSync(p.data)],
      ["ledger", existsSync(p.db)],
      ["documents", existsSync(p.documentsInbox)],
      ["config", existsSync(p.config)],
    ];
    let ok = true;
    for (const [name, pass] of checks) {
      console.log(`${pass ? "OK" : "FAIL"} ${name}`);
      if (!pass) ok = false;
    }
    if (!ok) process.exit(1);
  });
}
