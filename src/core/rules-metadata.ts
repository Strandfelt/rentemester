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
