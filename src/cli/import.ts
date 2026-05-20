import { readFileSync } from "node:fs";
import { migrate } from "../core/db";
import { runImport } from "../core/import/framework";
import { PARSERS } from "../core/import/synthetic-csv";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch } from "../cli-dispatch";

// `import run` — migrates a company from another accounting system into
// Rentemester. The framework (#185) parses the raw export with the per-system
// parser selected by `--system`, then lands the normalised result on the #179
// primobalance target. See src/core/import/.
//
// Only the synthetic-CSV example parser is wired today; the real e-conomic and
// Billy parsers are a follow-up (their formats need real export samples). They
// implement the same `SourceParser` contract and register in `PARSERS`.
export function register(dispatch: CommandDispatch): void {
  dispatch.on("import", "run", (ctx) => {
    const file = ctx.arg("--file");
    if (!file) {
      console.error("Missing required --file <export-file>");
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

    const raw = readFileSync(file, "utf8");
    const parsed = parser.parse(raw);
    if (!parsed.ok || !parsed.source) {
      ctx.emitResult({ ok: false, sourceSystem: system, errors: parsed.errors });
      process.exit(1);
    }

    const db = openCommandDb(ctx);
    migrate(db);
    const result = runImport(db, parsed.source, {
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
