import { existsSync } from "node:fs";
import { migrate } from "../core/db";
import { runImportFromSource } from "../core/import/framework";
import { PARSERS } from "../core/import/synthetic-csv";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch } from "../cli-dispatch";

// `import run` — migrates a company from another accounting system into
// Rentemester. The framework (#185) parses the raw export with the per-system
// parser selected by `--system`, then lands the normalised result on the live
// ledger: the chart of accounts + company master data are reconciled, and (for
// a primobalance import) the #179 primobalance is posted. See src/core/import/.
//
// `--file` accepts a single text file (synthetic-csv) OR an export directory
// (Dinero #193): the multi-file parser declares the files it needs.
export function register(dispatch: CommandDispatch): void {
  dispatch.on("import", "run", (ctx) => {
    const file = ctx.arg("--file");
    if (!file) {
      console.error("Missing required --file <export-file-or-directory>");
      process.exit(2);
    }
    if (!existsSync(file)) {
      console.error(`Export path does not exist: ${file}`);
      process.exit(2);
    }
    const system = ctx.trimToNull(ctx.arg("--system")) ?? "synthetic-csv";
    const parser = PARSERS[system];
    if (!parser) {
      console.error(
        `Unknown --system '${system}'. Available: ${Object.keys(PARSERS).join(", ")}`,
      );
      process.exit(2);
    }

    const db = openCommandDb(ctx);
    migrate(db);
    const result = runImportFromSource(db, parser, file, {
      createdBy: ctx.cliActor ?? ctx.inferredMutationActor() ?? undefined,
      createdByProgram: "rentemester-import-cli",
    });
    ctx.emitResult(result as unknown as Record<string, unknown>);
    db.close();
    if (!result.ok) process.exit(1);
  });

  dispatch.on("import", "systems", (ctx) => {
    const rows = Object.values(PARSERS).map((p) => ({ system: p.system, label: p.label }));
    if (ctx.outputFormat === "json") {
      ctx.emitResult({ ok: true, systems: rows });
    } else {
      console.table(rows);
    }
  });
}
