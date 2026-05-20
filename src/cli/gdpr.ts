// ===== GDPR (#184) =====
import { migrate } from "../core/db";
import { buildGdprSubjectExport, eraseGdprSubject } from "../core/gdpr";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch } from "../cli-dispatch";

/**
 * Registers the `gdpr export` (read) and `gdpr erase` (mutating) CLI
 * commands. A data subject is identified by `--cvr` and/or `--name`.
 */
export function register(dispatch: CommandDispatch): void {
  dispatch.on("gdpr", "export", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const result = buildGdprSubjectExport(db, {
      cvr: ctx.arg("--cvr") ?? null,
      name: ctx.arg("--name") ?? null,
      asOf: ctx.arg("--as-of") ?? null,
    });
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
    if (!result.ok) process.exit(1);
  });

  dispatch.on("gdpr", "erase", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const result = eraseGdprSubject(db, {
      cvr: ctx.arg("--cvr") ?? null,
      name: ctx.arg("--name") ?? null,
      asOf: ctx.arg("--as-of") ?? null,
    });
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
    if (!result.ok) process.exit(1);
  });
}
// ===== END GDPR (#184) =====
