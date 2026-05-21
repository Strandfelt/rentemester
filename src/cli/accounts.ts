import { migrate } from "../core/db";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch } from "../cli-dispatch";

export function register(dispatch: CommandDispatch): void {
  dispatch.on("accounts", "list", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const rows = db
      .query("SELECT account_no, name, type, default_vat_code FROM accounts ORDER BY account_no")
      .all() as Array<Record<string, unknown>>;
    // `docs/cli-contract.md` promises every result is available as JSON. The
    // accounts list used to always print a console.table, ignoring --json /
    // --format json — so an agent could not parse the chart of accounts. (#231)
    if (ctx.outputFormat === "json") {
      console.log(JSON.stringify({ ok: true, count: rows.length, rows }, null, 2));
      db.close();
      return;
    }
    console.table(rows);
    db.close();
  });
}
