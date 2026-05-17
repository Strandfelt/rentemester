export type OutputFormat = "json" | "human";

export function resolveOutputFormat(flags: Map<string, string | true>): OutputFormat | null {
  if (flags.has("--json")) return "json";
  const format = flags.get("--format");
  if (format === undefined) return process.stdout.isTTY ? "human" : "json";
  if (format === "json" || format === "human") return format;
  return null;
}

export function printStructuredResult(commandLabel: string, result: Record<string, unknown>, format: OutputFormat) {
  const ok = result.ok !== false;
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const lines = ok ? buildHumanSuccess(commandLabel, result) : buildHumanError(commandLabel, result);
  const text = lines.join("\n");
  if (ok) console.log(text);
  else console.error(text);
}

function buildHumanSuccess(commandLabel: string, result: Record<string, unknown>) {
  const lines = [`✔ ${commandLabel}`];
  for (const line of collectSummaryLines(result)) lines.push(`  ${line}`);
  const warnings = asStringArray(result.warnings);
  if (warnings.length > 0) {
    lines.push("  Advarsler:");
    for (const warning of warnings) lines.push(`    - ${warning}`);
  }
  return lines;
}

function buildHumanError(commandLabel: string, result: Record<string, unknown>) {
  const lines = [`✘ ${commandLabel} failed`];
  const errors = asStringArray(result.errors);
  if (errors.length > 0) {
    for (const error of errors) lines.push(`  → ${error}`);
  } else {
    lines.push("  → Kommandoen fejlede uden en specifik fejlbesked.");
  }
  const warnings = asStringArray(result.warnings);
  if (warnings.length > 0) {
    lines.push("  Advarsler:");
    for (const warning of warnings) lines.push(`    - ${warning}`);
  }
  return lines;
}

function collectSummaryLines(result: Record<string, unknown>) {
  const preferredKeys = [
    "message",
    "invoiceNumber",
    "invoiceNo",
    "entryNo",
    "entryNumber",
    "documentId",
    "journalEntryId",
    "importBatchId",
    "imported",
    "skippedDuplicates",
    "backupId",
    "exportDir",
    "latestBackupId",
    "expiredCount",
    "totalCount",
  ];
  const lines: string[] = [];
  for (const key of preferredKeys) {
    const value = result[key];
    const rendered = renderScalar(value);
    if (rendered === null) continue;
    lines.push(`${humanizeKey(key)}: ${rendered}`);
  }
  return lines;
}

function renderScalar(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function humanizeKey(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
