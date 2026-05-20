import { migrate } from "../core/db";
import { createCustomer, listCustomers } from "../core/master-data";
import { validateVatAgainstVies } from "../core/vies";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch } from "../cli-dispatch";

export function register(dispatch: CommandDispatch): void {
  dispatch.on("customer", "create", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const paymentTermsRaw = ctx.arg("--payment-terms");
    const paymentTerms = paymentTermsRaw === undefined ? undefined : Number(paymentTermsRaw);
    const result = createCustomer(db, {
      name: ctx.arg("--name") ?? "",
      address: ctx.arg("--address") ?? undefined,
      vatOrCvr: ctx.arg("--cvr") ?? undefined,
      email: ctx.arg("--email") ?? undefined,
      eanNumber: ctx.arg("--ean") ?? undefined,
      paymentTermsDays: Number.isFinite(paymentTerms) ? paymentTerms : undefined,
      defaultCurrency: ctx.arg("--currency") ?? undefined,
      notes: ctx.arg("--notes") ?? undefined,
    });
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
    if (!result.ok) process.exit(1);
  });

  dispatch.on("customer", "list", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const result = listCustomers(db, { archived: ctx.hasFlag("--archived") });
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
  });

  dispatch.on("customer", "validate-vat", async (ctx) => {
    const cvr = ctx.arg("--cvr");
    if (!cvr) {
      console.error("Missing required --cvr <EU-VAT>");
      process.exit(2);
    }
    const db = openCommandDb(ctx);
    migrate(db);
    const result = await validateVatAgainstVies(db, cvr);
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
    if (!result.ok) process.exit(1);
  });
}
