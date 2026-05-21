import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type RuleBundleMetadata = {
  name: string;
  path: string;
  version: string;
  ruleIds: string[];
  sourceIds: string[];
  declaredSources: string[];
  vatCodes: string[];
};

const rulesDir = fileURLToPath(new URL("../../rules/dk/", import.meta.url));
const legalSourcesPath = fileURLToPath(new URL("../../sources/legal-sources.json", import.meta.url));

function extractVersion(text: string, file: string) {
  const match = text.match(/^version:\s*(\S+)$/m);
  if (!match) throw new Error(`Missing version in ${file}`);
  return match[1];
}

function extractSectionValues(text: string, section: string, itemPattern: RegExp) {
  const values: string[] = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^[A-Za-z_]+:/.test(line)) {
      inSection = line.trim() === `${section}:`;
      continue;
    }
    if (!inSection) continue;
    const match = line.match(itemPattern);
    if (match) values.push(match[1]);
  }
  return values;
}

export function readRuleBundleMetadata(): RuleBundleMetadata[] {
  return readdirSync(rulesDir)
    .filter((file) => file.endsWith(".yaml"))
    .sort()
    .map((file) => {
      const path = join(rulesDir, file);
      const text = readFileSync(path, "utf8");
      return {
        name: file.replace(/\.yaml$/, ""),
        path,
        version: extractVersion(text, file),
        ruleIds: [...text.matchAll(/^\s*-\s*rule_id:\s*(\S+)$/gm)].map((match) => match[1]),
        sourceIds: [...text.matchAll(/^\s*source_id:\s*(\S+)$/gm)].map((match) => match[1]),
        declaredSources: extractSectionValues(text, "sources", /^\s*-\s*(DK-[A-Z0-9-]+)$/),
        vatCodes: extractSectionValues(text, "vat_codes", /^\s*-\s*code:\s*(\S+)$/),
      };
    });
}

export function currentRuleBundleVersion() {
  return readRuleBundleMetadata()
    .map((bundle) => `${bundle.name}=${bundle.version}`)
    .join(";");
}

export function readLegalSourceIds() {
  const sources = JSON.parse(readFileSync(legalSourcesPath, "utf8")) as Array<{ id: string }>;
  return sources.map((source) => source.id);
}

export type RuleProvisionCitation = {
  ref: string;
  textHash: string;
};

export type RuleMetadata = {
  ruleId: string;
  sourceId: string;
  bundle: string;
  provisions: RuleProvisionCitation[];
  severity: string;
  category: string;
};

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function indentOf(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === " ") count += 1;
  return count;
}

/**
 * Per-rule structured reader for the regulatory-coverage engine.
 *
 * The repo deliberately hand-parses YAML; this follows that pattern. A rule's
 * fields sit at 4-space indent. The optional `provisions:` block (added by the
 * citation workflow) is a list at 6-space indent whose entries carry `ref` and
 * `text_hash` keys at 8-space indent. Parsing is keyed purely on indentation so
 * it stays deterministic and dependency-free.
 */
export function readRuleMetadata(): RuleMetadata[] {
  const rules: RuleMetadata[] = [];
  const files = readdirSync(rulesDir)
    .filter((file) => file.endsWith(".yaml"))
    .sort();

  for (const file of files) {
    const bundle = file.replace(/\.yaml$/, "");
    const text = readFileSync(join(rulesDir, file), "utf8");
    const lines = text.split(/\r?\n/);

    let current: {
      ruleId: string;
      sourceId: string;
      severity: string;
      category: string;
      provisions: RuleProvisionCitation[];
    } | null = null;
    let inProvisions = false;
    let pendingRef: string | null = null;
    let pendingHash: string | null = null;

    const flushCitation = () => {
      if (current && pendingRef !== null && pendingHash !== null) {
        current.provisions.push({ ref: pendingRef, textHash: pendingHash });
      }
      pendingRef = null;
      pendingHash = null;
    };

    const flushRule = () => {
      flushCitation();
      if (current) {
        current.provisions.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
        rules.push({
          ruleId: current.ruleId,
          sourceId: current.sourceId,
          bundle,
          provisions: current.provisions,
          severity: current.severity,
          category: current.category,
        });
      }
      current = null;
      inProvisions = false;
    };

    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const indent = indentOf(line);
      const ruleStart = line.match(/^\s*-\s*rule_id:\s*(\S+)\s*$/);
      if (ruleStart) {
        flushRule();
        current = {
          ruleId: ruleStart[1],
          sourceId: "",
          severity: "",
          category: "",
          provisions: [],
        };
        continue;
      }
      if (!current) continue;

      // A new 4-space rule-level key closes any open provisions block.
      if (indent <= 4 && inProvisions && !/^\s*-\s/.test(line)) {
        flushCitation();
        inProvisions = false;
      }

      if (inProvisions) {
        const itemStart = line.match(/^\s{6}-\s*(.*)$/);
        if (itemStart) {
          flushCitation();
          const inline = itemStart[1].match(/^ref:\s*(.+)$/);
          if (inline) pendingRef = stripQuotes(inline[1]);
          continue;
        }
        if (indent >= 8) {
          const refMatch = line.match(/^\s*ref:\s*(.+)$/);
          if (refMatch) {
            pendingRef = stripQuotes(refMatch[1]);
            continue;
          }
          const hashMatch = line.match(/^\s*text_hash:\s*(.+)$/);
          if (hashMatch) {
            pendingHash = stripQuotes(hashMatch[1]);
            continue;
          }
          continue;
        }
      }

      const sourceMatch = line.match(/^\s{4}source_id:\s*(\S+)\s*$/);
      if (sourceMatch) {
        current.sourceId = sourceMatch[1];
        continue;
      }
      const severityMatch = line.match(/^\s{4}severity:\s*(\S+)\s*$/);
      if (severityMatch) {
        current.severity = stripQuotes(severityMatch[1]);
        continue;
      }
      const categoryMatch = line.match(/^\s{4}category:\s*(\S+)\s*$/);
      if (categoryMatch) {
        current.category = stripQuotes(categoryMatch[1]);
        continue;
      }
      if (/^\s{4}provisions:\s*$/.test(line)) {
        inProvisions = true;
        continue;
      }
    }
    flushRule();
  }

  rules.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
  return rules;
}
