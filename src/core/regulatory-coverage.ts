import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findProvision, loadAllProvisions, type Provision } from "./legal-provisions";
import { readRuleMetadata } from "./rules-metadata";

// Regulatory coverage — like code coverage, but it measures how much of the
// cited Danish legislation is traceably implemented in code. See
// docs/regulatory-coverage.md. The result is pure and deterministic.

export type ClosureError = {
  ruleId: string;
  sourceId: string;
  ref: string;
  reason: "unresolved" | "cross_source";
  resolvedSourceId?: string;
};

export type DriftError = {
  ruleId: string;
  sourceId: string;
  ref: string;
  citedTextHash: string;
  currentTextHash: string;
};

export type SourceCoverage = {
  sourceId: string;
  operativeCount: number;
  citedCount: number;
  coveredRefs: string[];
  uncoveredRefs: string[];
};

export type UncoveredProvision = {
  sourceId: string;
  ref: string;
};

export type ReverseMapEntry = {
  ruleId: string;
  codeFiles: string[];
  testFiles: string[];
};

export type ReverseMapRecord = {
  sourceId: string;
  ref: string;
  rules: ReverseMapEntry[];
};

export type RegulatoryCoverage = {
  overall: { operativeCount: number; citedCount: number };
  perSource: SourceCoverage[];
  closureErrors: ClosureError[];
  driftErrors: DriftError[];
  uncitedRules: string[];
  uncoveredProvisions: UncoveredProvision[];
  reverseMap: ReverseMapRecord[];
};

function repoRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Directory reads are sorted so the walk order is stable across filesystems.
function collectTsFiles(rootDir: string, dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      out.push(...collectTsFiles(rootDir, full));
    } else if (entry.endsWith(".ts")) {
      out.push(full.slice(rootDir.length).replace(/\\/g, "/").replace(/^\/+/, ""));
    }
  }
  return out;
}

type ScanIndex = { codeFiles: string[]; testFiles: string[] };

// Matches a rule-id-shaped token as a whole word, so DK-FOO-001 is not found
// inside DK-FOO-0011 or a longer identifier.
const RULE_ID_TOKEN_RE = /(?<![A-Za-z0-9])DK-[A-Z0-9-]+-\d{3}(?![0-9])/g;

// For every rule id, the sorted lists of files under src/ and tests/ that
// reference it. Each file is scanned once for all rule-id tokens.
function buildScanIndex(rootDir: string, ruleIds: string[]): Map<string, ScanIndex> {
  const index = new Map<string, ScanIndex>();
  for (const ruleId of ruleIds) index.set(ruleId, { codeFiles: [], testFiles: [] });
  const known = new Set(ruleIds);

  const srcFiles = collectTsFiles(rootDir, join(rootDir, "src"));
  const testFiles = collectTsFiles(rootDir, join(rootDir, "tests"));

  const scan = (relPaths: string[], target: "codeFiles" | "testFiles") => {
    for (const rel of relPaths) {
      let text: string;
      try {
        text = readFileSync(join(rootDir, rel), "utf8");
      } catch {
        continue;
      }
      const seen = new Set<string>();
      for (const match of text.matchAll(RULE_ID_TOKEN_RE)) {
        const token = match[0];
        if (known.has(token) && !seen.has(token)) {
          seen.add(token);
          index.get(token)![target].push(rel);
        }
      }
    }
  };
  scan(srcFiles, "codeFiles");
  scan(testFiles, "testFiles");
  return index;
}

export function computeRegulatoryCoverage(rootDir: string = repoRoot()): RegulatoryCoverage {
  const provisionsBySource = loadAllProvisions(rootDir);
  const rules = readRuleMetadata();
  const ruleIds = [...new Set(rules.map((rule) => rule.ruleId))].sort(compareStrings);
  const scanIndex = buildScanIndex(rootDir, ruleIds);

  const closureErrors: ClosureError[] = [];
  const driftErrors: DriftError[] = [];
  const uncitedRules: string[] = [];

  // (sourceId -> (ref -> set of rule ids)) for citations that resolve cleanly.
  const citationsBySource = new Map<string, Map<string, Set<string>>>();
  const addCitation = (sourceId: string, ref: string, ruleId: string) => {
    let byRef = citationsBySource.get(sourceId);
    if (!byRef) {
      byRef = new Map();
      citationsBySource.set(sourceId, byRef);
    }
    let ruleSet = byRef.get(ref);
    if (!ruleSet) {
      ruleSet = new Set();
      byRef.set(ref, ruleSet);
    }
    ruleSet.add(ruleId);
  };

  for (const rule of rules) {
    if (rule.provisions.length === 0) {
      uncitedRules.push(rule.ruleId);
      continue;
    }
    const sourceProvisions = provisionsBySource.get(rule.sourceId) ?? [];
    for (const citation of rule.provisions) {
      const resolved = findProvision(sourceProvisions, citation.ref);
      if (!resolved) {
        // Not in the rule's declared source — check whether it resolves
        // anywhere else, which is the more specific (cross-source) error.
        let crossSource: string | undefined;
        for (const [otherSourceId, provs] of [...provisionsBySource.entries()].sort((a, b) =>
          compareStrings(a[0], b[0]),
        )) {
          if (otherSourceId === rule.sourceId) continue;
          if (findProvision(provs, citation.ref)) {
            crossSource = otherSourceId;
            break;
          }
        }
        closureErrors.push(
          crossSource
            ? {
                ruleId: rule.ruleId,
                sourceId: rule.sourceId,
                ref: citation.ref,
                reason: "cross_source",
                resolvedSourceId: crossSource,
              }
            : {
                ruleId: rule.ruleId,
                sourceId: rule.sourceId,
                ref: citation.ref,
                reason: "unresolved",
              },
        );
        continue;
      }
      if (resolved.textHash !== citation.textHash) {
        driftErrors.push({
          ruleId: rule.ruleId,
          sourceId: rule.sourceId,
          ref: citation.ref,
          citedTextHash: citation.textHash,
          currentTextHash: resolved.textHash,
        });
      }
      // A citation contributes to coverage once it resolves to the rule's
      // declared source, independent of drift — drift is reported separately.
      addCitation(rule.sourceId, citation.ref, rule.ruleId);
    }
  }
  uncitedRules.sort(compareStrings);
  closureErrors.sort(
    (a, b) =>
      compareStrings(a.ruleId, b.ruleId) ||
      compareStrings(a.sourceId, b.sourceId) ||
      compareStrings(a.ref, b.ref),
  );
  driftErrors.sort(
    (a, b) =>
      compareStrings(a.ruleId, b.ruleId) ||
      compareStrings(a.sourceId, b.sourceId) ||
      compareStrings(a.ref, b.ref),
  );

  const perSource: SourceCoverage[] = [];
  const uncoveredProvisions: UncoveredProvision[] = [];
  const reverseMap: ReverseMapRecord[] = [];
  let overallOperative = 0;
  let overallCited = 0;

  const buildReverseEntries = (ruleSet: Set<string>): ReverseMapEntry[] =>
    [...ruleSet].sort(compareStrings).map((ruleId) => {
      const scan = scanIndex.get(ruleId) ?? { codeFiles: [], testFiles: [] };
      return {
        ruleId,
        codeFiles: [...scan.codeFiles].sort(compareStrings),
        testFiles: [...scan.testFiles].sort(compareStrings),
      };
    });

  for (const [sourceId, provisions] of [...provisionsBySource.entries()].sort((a, b) =>
    compareStrings(a[0], b[0]),
  )) {
    const operative = provisions.filter((p: Provision) => p.kind === "operative");
    const byRef = citationsBySource.get(sourceId) ?? new Map<string, Set<string>>();
    const coveredRefs: string[] = [];
    const uncoveredRefs: string[] = [];
    for (const provision of operative) {
      if (byRef.has(provision.ref)) {
        coveredRefs.push(provision.ref);
      } else {
        uncoveredRefs.push(provision.ref);
        uncoveredProvisions.push({ sourceId, ref: provision.ref });
      }
    }
    coveredRefs.sort(compareStrings);
    uncoveredRefs.sort(compareStrings);
    perSource.push({
      sourceId,
      operativeCount: operative.length,
      citedCount: coveredRefs.length,
      coveredRefs,
      uncoveredRefs,
    });
    overallOperative += operative.length;
    overallCited += coveredRefs.length;

    for (const [ref, ruleSet] of [...byRef.entries()].sort((a, b) =>
      compareStrings(a[0], b[0]),
    )) {
      reverseMap.push({ sourceId, ref, rules: buildReverseEntries(ruleSet) });
    }
  }

  reverseMap.sort(
    (a, b) => compareStrings(a.sourceId, b.sourceId) || compareStrings(a.ref, b.ref),
  );

  return {
    overall: { operativeCount: overallOperative, citedCount: overallCited },
    perSource,
    closureErrors,
    driftErrors,
    uncitedRules,
    uncoveredProvisions,
    reverseMap,
  };
}

function fraction(numerator: number, denominator: number): string {
  if (denominator === 0) return "n/a (0 operative provisions)";
  return `${numerator}/${denominator}`;
}

// Deterministic Markdown report — a pure function of repo state, no timestamps,
// so it can be committed and diffed.
export function renderRegulatoryCoverageReport(coverage: RegulatoryCoverage): string {
  const lines: string[] = [];
  lines.push("# Regulatory coverage");
  lines.push("");
  lines.push(
    "Generated by `rentemester reg coverage`. This report is a deterministic " +
      "function of the rule citations and the legal-source corpus — no timestamps.",
  );
  lines.push("");
  lines.push(
    `Overall operative-provision coverage: ${fraction(
      coverage.overall.citedCount,
      coverage.overall.operativeCount,
    )}`,
  );
  lines.push("");
  lines.push(`Closure errors: ${coverage.closureErrors.length}`);
  lines.push(`Drift errors: ${coverage.driftErrors.length}`);
  lines.push(`Uncited rules: ${coverage.uncitedRules.length}`);
  lines.push("");

  lines.push("## Coverage per source");
  lines.push("");
  lines.push("| Source | Operative provisions | Cited | Coverage |");
  lines.push("| --- | --- | --- | --- |");
  for (const source of coverage.perSource) {
    lines.push(
      `| ${source.sourceId} | ${source.operativeCount} | ${source.citedCount} | ${fraction(
        source.citedCount,
        source.operativeCount,
      )} |`,
    );
  }
  lines.push("");

  if (coverage.closureErrors.length > 0) {
    lines.push("## Closure errors");
    lines.push("");
    for (const error of coverage.closureErrors) {
      const detail =
        error.reason === "cross_source"
          ? `resolves in ${error.resolvedSourceId}, not the rule's source`
          : "does not resolve to any provision";
      lines.push(`- ${error.ruleId} (${error.sourceId}) — \`${error.ref}\`: ${detail}`);
    }
    lines.push("");
  }

  if (coverage.driftErrors.length > 0) {
    lines.push("## Drift errors");
    lines.push("");
    for (const error of coverage.driftErrors) {
      lines.push(
        `- ${error.ruleId} (${error.sourceId}) — \`${error.ref}\`: cited ` +
          `${error.citedTextHash} but current is ${error.currentTextHash}`,
      );
    }
    lines.push("");
  }

  lines.push("## Covered and uncovered provisions per source");
  lines.push("");
  const rulesByKey = new Map<string, string[]>();
  for (const record of coverage.reverseMap) {
    rulesByKey.set(
      `${record.sourceId} ${record.ref}`,
      record.rules.map((entry) => entry.ruleId).sort(compareStrings),
    );
  }
  for (const source of coverage.perSource) {
    lines.push(`### ${source.sourceId}`);
    lines.push("");
    if (source.coveredRefs.length === 0) {
      lines.push("_No operative provisions cited yet._");
    } else {
      lines.push("Covered:");
      for (const ref of source.coveredRefs) {
        const ruleIds = rulesByKey.get(`${source.sourceId} ${ref}`) ?? [];
        lines.push(`- \`${ref}\` — ${ruleIds.join(", ")}`);
      }
    }
    lines.push("");
    if (source.uncoveredRefs.length > 0) {
      lines.push(`Uncovered operative provisions (${source.uncoveredRefs.length}):`);
      for (const ref of source.uncoveredRefs) lines.push(`- \`${ref}\``);
      lines.push("");
    }
  }

  if (coverage.reverseMap.length > 0) {
    lines.push("## Traceability (provision → rule → code → tests)");
    lines.push("");
    let currentSource = "";
    for (const record of coverage.reverseMap) {
      if (record.sourceId !== currentSource) {
        currentSource = record.sourceId;
        lines.push(`### ${currentSource}`);
        lines.push("");
      }
      lines.push(`- \`${record.ref}\``);
      for (const entry of record.rules) {
        const code = entry.codeFiles.length > 0 ? entry.codeFiles.join(", ") : "—";
        const tests = entry.testFiles.length > 0 ? entry.testFiles.join(", ") : "—";
        lines.push(`  - ${entry.ruleId} — code: ${code} — tests: ${tests}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "\n");
}
