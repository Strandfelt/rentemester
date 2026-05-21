import { writeFileSync } from "node:fs";
import {
  computeRegulatoryCoverage,
  renderRegulatoryCoverageReport,
} from "../core/regulatory-coverage";
import type { CommandDispatch } from "../cli-dispatch";

// `reg coverage` — regulatory coverage, like code coverage but for the cited
// Danish legislation. It is repo-static: it reads rules/dk/*.yaml and the
// legal-source corpus, so it needs no --company. With --out it also writes the
// deterministic Markdown report.
export function register(dispatch: CommandDispatch): void {
  dispatch.on("reg", "coverage", (ctx) => {
    const coverage = computeRegulatoryCoverage();
    const out = ctx.trimToNull(ctx.arg("--out"));
    if (out) {
      writeFileSync(out, renderRegulatoryCoverageReport(coverage), "utf8");
    }

    const result: Record<string, unknown> = {
      ok: coverage.closureErrors.length === 0 && coverage.driftErrors.length === 0,
      operativeProvisions: coverage.overall.operativeCount,
      citedProvisions: coverage.overall.citedCount,
      closureErrors: coverage.closureErrors.length,
      driftErrors: coverage.driftErrors.length,
      uncitedRules: coverage.uncitedRules.length,
      perSource: coverage.perSource.map((source) => ({
        sourceId: source.sourceId,
        operativeProvisions: source.operativeCount,
        citedProvisions: source.citedCount,
      })),
    };
    if (out) result.reportPath = out;
    if (coverage.closureErrors.length > 0 || coverage.driftErrors.length > 0) {
      result.errors = [
        ...coverage.closureErrors.map(
          (error) =>
            `closure: ${error.ruleId} (${error.sourceId}) cites unresolved ${error.ref}`,
        ),
        ...coverage.driftErrors.map(
          (error) =>
            `drift: ${error.ruleId} (${error.sourceId}) cites stale ${error.ref}`,
        ),
      ];
    }

    if (ctx.outputFormat === "json") {
      ctx.emitResult(result);
      return;
    }

    // Human output: a deterministic summary table. The structured renderer
    // only surfaces a fixed set of keys, so the per-source breakdown is
    // printed directly here.
    const ok = result.ok === true;
    const lines: string[] = [];
    lines.push(`${ok ? "✔" : "✘"} reg coverage`);
    lines.push(
      `  Operative provisions cited: ${coverage.overall.citedCount}/${coverage.overall.operativeCount}`,
    );
    lines.push(`  Closure errors: ${coverage.closureErrors.length}`);
    lines.push(`  Drift errors: ${coverage.driftErrors.length}`);
    lines.push(`  Uncited rules: ${coverage.uncitedRules.length}`);
    if (out) lines.push(`  Report: ${out}`);
    lines.push("  Per source:");
    for (const source of coverage.perSource) {
      lines.push(
        `    ${source.sourceId}: ${source.citedCount}/${source.operativeCount}`,
      );
    }
    for (const error of (result.errors as string[] | undefined) ?? []) {
      lines.push(`  → ${error}`);
    }
    const text = lines.join("\n");
    if (ok) console.log(text);
    else {
      console.error(text);
      process.exitCode = 1;
    }
  });
}
