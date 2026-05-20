// ===== BANK CLUSTER (#187) =====
import { migrate } from "../core/db";
import { addBankAccount, listBankAccounts } from "../core/bank";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch } from "../cli-dispatch";

/**
 * CLI for bank accounts as a first-class entity (#187).
 *
 *  - `bank-account add`  — registers a bank account in the company ledger
 *  - `bank-account list` — lists registered bank accounts
 *
 * `bank import --account <id|slug>` couples imported rows to one of these.
 */
export function register(dispatch: CommandDispatch): void {
  dispatch.on("bank-account", "add", (ctx) => {
    const name = ctx.trimToNull(ctx.arg("--name"));
    if (!name) return ctx.fatal("bank-account add requires --name <text>");
    const db = openCommandDb(ctx);
    migrate(db);
    const result = addBankAccount(db, {
      name,
      slug: ctx.arg("--slug"),
      bankName: ctx.arg("--bank-name"),
      registrationNo: ctx.arg("--registration-no"),
      accountNo: ctx.arg("--account-no"),
      iban: ctx.arg("--iban"),
      currency: ctx.arg("--currency"),
      ledgerAccountNo: ctx.arg("--ledger-account"),
    });
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
    if (!result.ok) process.exit(1);
  });

  dispatch.on("bank-account", "list", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const result = listBankAccounts(db);
    if (ctx.outputFormat === "json") {
      ctx.emitResult(result as Record<string, unknown>);
    } else if (result.accounts.length === 0) {
      console.log("No bank accounts registered yet. Run 'bank-account add'.");
    } else {
      console.table(result.accounts);
    }
    db.close();
  });
}
// ===== END BANK CLUSTER (#187) =====
