import { migrate } from "../core/db";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch } from "../cli-dispatch";

export function register(dispatch: CommandDispatch): void {
  dispatch.on("accounts", "list", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const rows = db
      .query("SELECT account_no, name, type, default_vat_code FROM accounts ORDER BY account_no")
      .all();
    console.table(rows);
    db.close();
  });
}
