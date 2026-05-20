import { readFileSync } from "node:fs";
import { migrate } from "../core/db";
import {
  buildVatReport,
  postEuServiceReverseChargePurchase,
  postRepresentationPurchase,
} from "../core/vat";
import { openCommandDb } from "../cli-dispatch";
import type { CommandContext, CommandDispatch } from "../cli-dispatch";
// ===== VAT FILING (#178) =====
import { buildVatFiling } from "../core/vat-filing";
// ===== END VAT FILING (#178) =====

export function register(dispatch: CommandDispatch): void {
  dispatch.on("vat", "report", (ctx) => {
    const from = ctx.arg("--from");
    const to = ctx.arg("--to");
    if (!from || !to) {
      console.error("Missing required --from <YYYY-MM-DD> or --to <YYYY-MM-DD>");
      process.exit(2);
    }
    const db = openCommandDb(ctx);
    migrate(db);
    const result = buildVatReport(db, from, to);
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
  });

  dispatch.on("vat", "post-eu-service-purchase", (ctx) => {
    const input = ctx.arg("--input");
    if (!input) {
      console.error("Missing required --input <file.json>");
      process.exit(2);
    }
    const db = openCommandDb(ctx);
    migrate(db);
    const payload = JSON.parse(readFileSync(input, "utf8"));
    const invoiceNo = typeof payload.invoiceNo === "string" ? payload.invoiceNo.trim() : "";
    if (invoiceNo) {
      const row = db
        .query(`SELECT id FROM documents WHERE invoice_no = ? ORDER BY id DESC LIMIT 1`)
        .get(invoiceNo) as { id: number } | null;
      if (!row) {
        console.error(`Could not resolve document for invoiceNo ${invoiceNo}`);
        process.exit(2);
      }
      payload.documentId = row.id;
    }
    const result = postEuServiceReverseChargePurchase(db, payload);
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
  });

  dispatch.on("vat", "post-representation-purchase", (ctx) => {
    const input = ctx.arg("--input");
    if (!input) {
      console.error("Missing required --input <file.json>");
      process.exit(2);
    }
    const db = openCommandDb(ctx);
    migrate(db);
    const payload = JSON.parse(readFileSync(input, "utf8"));
    const result = postRepresentationPurchase(db, payload);
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
  });

  // ===== VAT FILING (#178) =====
  // `vat momsangivelse` (alias `vat filing`): produce a filing-ready
  // momsangivelse — the standard SKAT rubrikker plus momstilsvar — for a
  // closed VAT period. Read-only: Rentemester produces the numbers, the user
  // files them via TastSelv.
  const emitVatFiling = (ctx: CommandContext) => {
    const from = ctx.arg("--from");
    const to = ctx.arg("--to");
    if (!from || !to) {
      console.error("Missing required --from <YYYY-MM-DD> or --to <YYYY-MM-DD>");
      process.exit(2);
    }
    const db = openCommandDb(ctx);
    migrate(db);
    const result = buildVatFiling(db, from, to);
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
  };
  dispatch.on("vat", "momsangivelse", emitVatFiling);
  dispatch.on("vat", "filing", emitVatFiling);
  // ===== END VAT FILING (#178) =====
}
