import { vatFilingDeadline } from "./core/vat";

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

/**
 * A command's `description` in `cli-meta.ts` is a full sentence (often two)
 * meant for help text — never a heading. #268: a write command that falls
 * through to the generic human renderer used to print that whole description
 * as the `✔` heading. `headingFromLabel` collapses such a label to a short
 * heading: the first clause before an em dash / period, capped in length.
 */
function headingFromLabel(commandLabel: string): string {
  const firstClause = commandLabel.split(/\s+[—–-]\s+|\.\s/)[0]?.trim() ?? commandLabel;
  const short = firstClause.length > 0 ? firstClause : commandLabel;
  return short.length > 60 ? `${short.slice(0, 57).trimEnd()}…` : short;
}

function buildHumanSuccess(commandLabel: string, result: Record<string, unknown>) {
  const lines = [`✔ ${headingFromLabel(commandLabel)}`];
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
  appendPeriodCloseGuidance(lines, errors);
  return lines;
}

/**
 * `vat momsangivelse` and `report annual` reject an unfinalised period with a
 * terse "... is not closed ... run 'period close' first". For an owner near a
 * deadline that is cryptic, so when we recognise that failure we append a
 * plain-Danish explanation of what closing a period means and the exact
 * command to run. (#227)
 */
function appendPeriodCloseGuidance(lines: string[], errors: string[]): void {
  const closeError = errors.find(
    (e) => /is not closed/i.test(e) && /period close/i.test(e),
  );
  if (!closeError) return;
  const range = closeError.match(/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/);
  const isFiscalYear = /fiscal|regnskabsår|annual/i.test(closeError);
  const kind = isFiscalYear ? "fiscal_year" : "vat_quarter";
  const fromTo = range ? `--from ${range[1]} --to ${range[2]}` : "--from <YYYY-MM-DD> --to <YYYY-MM-DD>";
  lines.push("");
  lines.push("  Sådan kommer du videre:");
  lines.push(
    "    En momsangivelse/årsrapport kan kun bygges på en LUKKET periode — det sikrer,",
  );
  lines.push(
    "    at tallene ikke ændrer sig efter indberetning. Du lukker perioden med:",
  );
  lines.push(`      rentemester period close --company <path> ${fromTo} --kind ${kind}`);
  lines.push(
    "    Luk først perioden når alle bilag for perioden er bogført — en lukket periode",
  );
  lines.push(
    "    blokerer ny bogføring med dato i perioden. Brug --status reported i stedet for",
  );
  lines.push(
    "    standard 'closed', hvis du allerede har indberettet til SKAT/Erhvervsstyrelsen.",
  );
}

/**
 * Danish labels for the result keys a write command commonly returns. The
 * generic human fallback (`collectSummaryLines`) used to English-ify keys via
 * `humanizeKey` ("Invoice Number", "Document Id"); for a Danish-facing tool
 * that is wrong. Any key without an entry here keeps the humanized form, but
 * the common write-result fields are now translated. (#268)
 */
const WRITE_RESULT_LABEL_DA: Record<string, string> = {
  message: "Besked",
  invoiceNumber: "Fakturanummer",
  invoiceNo: "Fakturanummer",
  entryNo: "Posteringsnummer",
  entryNumber: "Posteringsnummer",
  documentId: "Bilags-id",
  journalEntryId: "Finanspostering-id",
  importBatchId: "Import-batch-id",
  imported: "Importeret",
  skippedDuplicates: "Sprunget over (dubletter)",
  backupId: "Backup-id",
  exportDir: "Eksportmappe",
  latestBackupId: "Seneste backup-id",
  expiredCount: "Udløbne",
  totalCount: "I alt",
  storedPath: "Gemt fil",
  pdfStoredPath: "PDF-fil",
};

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
    // #268: never emit an English key on a Danish-facing tool — use the Danish
    // label when one exists, falling back to the humanized form otherwise.
    lines.push(`${WRITE_RESULT_LABEL_DA[key] ?? humanizeKey(key)}: ${rendered}`);
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

// ===========================================================================
// HUMAN-READABLE REPORT RENDERING (#211)
// ---------------------------------------------------------------------------
// Read/report commands emit deterministic JSON with English field names for
// agents. When a human runs them (`--format human` / a TTY) that JSON is
// unreadable. `renderHumanReport` renders the same payloads in clear Danish
// with money in kroner-og-øre. The `--format json` path is untouched: handlers
// keep calling `ctx.emitResult` for JSON and only branch into this renderer
// for the human format.
// ===========================================================================

/** Report kinds with a dedicated Danish human renderer. */
export type HumanReportKind =
  | "vat-report"
  | "vat-filing"
  | "report-annual"
  | "invoice-status"
  | "invoice-interest"
  | "invoice-compensation"
  | "invoice-validate"
  | "exceptions-list"
  | "report-trial-balance"
  | "report-profit-loss"
  | "report-balance"
  | "retention-status"
  | "reconcile-bank"
  | "backup-status";

/**
 * Format a DKK amount as Danish kroner-og-øre, e.g. 38.3 -> "38,30 kr.",
 * -1234.5 -> "-1.234,50 kr.". Non-finite/missing input yields "—".
 */
export function formatKroner(value: unknown): string {
  const num = typeof value === "number" ? value : Number(value);
  if (value == null || value === "" || !Number.isFinite(num)) return "—";
  const negative = num < 0;
  const cents = Math.round(Math.abs(num) * 100);
  const whole = Math.floor(cents / 100);
  const fraction = (cents % 100).toString().padStart(2, "0");
  const wholeText = whole
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${wholeText},${fraction} kr.`;
}

/** Render an integer count, falling back to 0 for missing values. */
function asCount(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
}

function asText(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    : [];
}

/** Danish labels for the exception severities and statuses. */
const SEVERITY_DA: Record<string, string> = {
  low: "lav",
  medium: "middel",
  high: "høj",
};
const EXCEPTION_STATUS_DA: Record<string, string> = {
  open: "åben",
  resolved: "løst",
};
const INVOICE_STATUS_DA: Record<string, string> = {
  open: "åben",
  paid: "betalt",
  credited: "krediteret",
  refunded: "refunderet",
  overpaid: "overbetalt",
  written_off: "afskrevet",
};

/**
 * Render a read/report `result` payload as Danish human-readable text.
 *
 * Returns `null` when there is no dedicated renderer for `kind` or the payload
 * does not look renderable, so callers can fall back to the generic
 * `printStructuredResult` rendering.
 */
export function renderHumanReport(
  kind: HumanReportKind,
  result: Record<string, unknown>,
): string | null {
  // `backup-status` reports `ok: false` when the weekly backup duty is NOT met
  // — that is a valid compliance status to render, not a command failure. Its
  // renderer handles both states, so it must run before the generic
  // ok-false-as-error path. (#240)
  if (kind === "backup-status") {
    return renderBackupStatus(result);
  }
  // `invoice validate` reports `ok: false` when the payload is INVALID — that
  // is a valid validation verdict to render in full (the figures and every
  // rejection reason), not a command crash. Its renderer covers both the
  // valid and invalid verdict, so it must run before the generic
  // ok-false-as-error path. (#250)
  if (kind === "invoice-validate") {
    return renderInvoiceValidate(result);
  }
  if (result.ok === false) {
    return buildHumanError(humanReportTitle(kind), result).join("\n");
  }
  switch (kind) {
    case "vat-report":
      return renderVatReport(result);
    case "vat-filing":
      return renderVatFiling(result);
    case "report-annual":
      return renderAnnualReport(result);
    case "invoice-status":
      return renderInvoiceStatus(result);
    case "invoice-interest":
      return renderInvoiceInterest(result);
    case "invoice-compensation":
      return renderInvoiceCompensation(result);
    case "exceptions-list":
      return renderExceptionsList(result);
    case "report-trial-balance":
      return renderTrialBalance(result);
    case "report-profit-loss":
      return renderProfitAndLoss(result);
    case "report-balance":
      return renderBalanceSheet(result);
    case "retention-status":
      return renderRetentionStatus(result);
    case "reconcile-bank":
      return renderBankReconciliation(result);
    default:
      // `backup-status` and `invoice-validate` are handled before this switch
      // (their renderers cover the ok:false state too), so they never reach
      // here.
      return null;
  }
}

/**
 * Emit a read/report `result` either as the byte-stable agent JSON or as the
 * Danish human rendering, depending on `format`. The `--format json` path is
 * exactly `JSON.stringify(result, null, 2)` — unchanged from `emitResult` —
 * so agents see no difference. Only the human rendering is new.
 *
 * Returns the process exit code to apply (1 when `result.ok === false`).
 */
export function emitHumanReport(
  kind: HumanReportKind,
  result: Record<string, unknown>,
  format: OutputFormat,
): void {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const human = renderHumanReport(kind, result);
    if (human !== null) {
      if (result.ok === false) console.error(human);
      else console.log(human);
    } else {
      printStructuredResult(humanReportTitle(kind), result, format);
    }
  }
  if (result.ok === false) process.exitCode = 1;
}

function humanReportTitle(kind: HumanReportKind): string {
  switch (kind) {
    case "vat-report":
      return "Momsrapport";
    case "vat-filing":
      return "Momsangivelse";
    case "report-annual":
      return "Årsrapport";
    case "invoice-status":
      return "Fakturastatus";
    case "invoice-interest":
      return "Morarente";
    case "invoice-compensation":
      return "Kompensation for sen betaling";
    case "invoice-validate":
      return "Fakturavalidering";
    case "exceptions-list":
      return "Exceptions-kø";
    case "report-trial-balance":
      return "Saldobalance";
    case "report-profit-loss":
      return "Resultatopgørelse";
    case "report-balance":
      return "Balance";
    case "retention-status":
      return "Opbevaringsstatus";
    case "reconcile-bank":
      return "Bankafstemning";
    case "backup-status":
      return "Backup-status";
  }
}

function appendWarnings(lines: string[], result: Record<string, unknown>): void {
  const warnings = asStringArray(result.warnings);
  if (warnings.length === 0) return;
  lines.push("");
  lines.push("Advarsler:");
  for (const warning of warnings) lines.push(`  - ${warning}`);
}

// --- VAT report ------------------------------------------------------------

function renderVatReport(result: Record<string, unknown>): string {
  const from = asText(result.periodStart);
  const to = asText(result.periodEnd);
  const net = typeof result.netVatPayable === "number" ? result.netVatPayable : Number(result.netVatPayable);
  const lines: string[] = [];
  lines.push(`Momsrapport for perioden ${from} til ${to}`);
  lines.push("");

  if (Number.isFinite(net) && net > 0) {
    lines.push(`Du skal betale ${formatKroner(net)} i moms for perioden.`);
  } else if (Number.isFinite(net) && net < 0) {
    lines.push(`Du har ${formatKroner(-net)} til gode i moms for perioden.`);
  } else {
    lines.push("Momstilsvaret for perioden er 0,00 kr.");
  }
  lines.push("");
  lines.push(`  Salgsmoms (udgående moms):     ${formatKroner(result.outputVat)}`);
  lines.push(`  Købsmoms (indgående moms):     ${formatKroner(result.inputVat)}`);
  lines.push(`  Momstilsvar (netto):           ${formatKroner(result.netVatPayable)}`);
  lines.push("");
  lines.push("Momsgrundlag:");
  lines.push(`  Køb med 25% moms:              ${formatKroner(result.purchaseBase25)}`);
  lines.push(`  Salg med 25% moms:             ${formatKroner(result.salesBase25)}`);
  if (asCount(result.reverseChargeSalesBase) !== 0) {
    lines.push(`  Salg med omvendt betalingspligt: ${formatKroner(result.reverseChargeSalesBase)}`);
  }
  if (asCount(result.reverseChargePurchaseBase) !== 0) {
    lines.push(`  Køb med omvendt betalingspligt:  ${formatKroner(result.reverseChargePurchaseBase)}`);
  }
  if (asCount(result.representationPurchaseBase) !== 0) {
    lines.push(`  Repræsentationskøb:            ${formatKroner(result.representationPurchaseBase)}`);
  }
  if (asCount(result.badDebtReliefBase25) !== 0) {
    lines.push(`  Tab på debitorer (25%):        ${formatKroner(result.badDebtReliefBase25)}`);
  }
  lines.push("");
  const entries = asCount(result.journalEntryCount);
  const postLines = asCount(result.linesConsidered);
  lines.push(
    `Rapporten dækker ${entries} finanspostering${entries === 1 ? "" : "er"}` +
      ` (${postLines} posteringslinje${postLines === 1 ? "" : "r"}).`,
  );
  // SKAT filing/payment deadline — the date that costs money if missed. (#236)
  const deadline = vatFilingDeadline(to);
  if (deadline) {
    lines.push("");
    lines.push(`SKAT-frist for indberetning og betaling: ${deadline}`);
    lines.push(
      "  (kvartalsmoms skal angives og betales senest den 1. i tredje måned efter periodens udløb)",
    );
  }
  appendWarnings(lines, result);
  return lines.join("\n");
}

// --- VAT filing (momsangivelse) --------------------------------------------

/**
 * Render a `vat momsangivelse` / `vat filing` payload as Danish human text.
 * The payload is the `VatFilingReport` from `buildVatFiling` — the SKAT
 * rubrikker plus momstilsvar and the filing deadline. (#235, #236)
 */
function renderVatFiling(result: Record<string, unknown>): string {
  const from = asText(result.periodStart);
  const to = asText(result.periodEnd);
  const lines: string[] = [];
  lines.push(`Momsangivelse for perioden ${from} til ${to}`);
  lines.push("");

  const rubrikker = (typeof result.rubrikker === "object" && result.rubrikker !== null
    ? result.rubrikker
    : {}) as Record<string, unknown>;
  const tilsvar = typeof rubrikker.momstilsvar === "number"
    ? rubrikker.momstilsvar
    : Number(rubrikker.momstilsvar);

  if (Number.isFinite(tilsvar) && tilsvar > 0) {
    lines.push(`Du skal betale ${formatKroner(tilsvar)} i moms til SKAT for perioden.`);
  } else if (Number.isFinite(tilsvar) && tilsvar < 0) {
    lines.push(`Du har ${formatKroner(-tilsvar)} til gode i moms (negativt momstilsvar).`);
  } else {
    lines.push("Momstilsvaret for perioden er 0,00 kr.");
  }
  lines.push("");
  lines.push("Rubrikker til TastSelv Erhverv:");
  lines.push(`  Salgsmoms:                       ${formatKroner(rubrikker.salgsmoms)}`);
  lines.push(`  Moms af varekøb i udlandet:      ${formatKroner(rubrikker.momsAfVarekobUdland)}`);
  lines.push(`  Moms af ydelseskøb i udlandet:   ${formatKroner(rubrikker.momsAfYdelseskobUdland)}`);
  lines.push(`  Købsmoms:                        ${formatKroner(rubrikker.kobsmoms)}`);
  lines.push(`  Momstilsvar:                     ${formatKroner(rubrikker.momstilsvar)}`);
  lines.push(`  Rubrik A (køb i udlandet):       ${formatKroner(rubrikker.rubrikA)}`);
  lines.push(`  Rubrik B (salg i udlandet):      ${formatKroner(rubrikker.rubrikB)}`);
  lines.push(`  Rubrik C (øvrigt momsfrit salg): ${formatKroner(rubrikker.rubrikC)}`);
  lines.push("");

  const statusDa = result.periodStatus === "reported"
    ? "indberettet"
    : result.periodStatus === "closed"
      ? "lukket"
      : "åben";
  lines.push(`  Periodestatus:                   ${statusDa}`);
  if (result.periodReference) {
    lines.push(`  Periodereference:                ${asText(result.periodReference)}`);
  }
  const deadline = asText(result.filingDeadline, "") || vatFilingDeadline(to) || "";
  if (deadline) {
    lines.push("");
    lines.push(`SKAT-frist for indberetning og betaling: ${deadline}`);
    lines.push(
      "  (kvartalsmoms skal angives og betales senest den 1. i tredje måned efter periodens udløb)",
    );
  }
  lines.push("");
  lines.push(
    "Rentemester producerer tallene — du indberetter dem selv via TastSelv Erhverv.",
  );
  appendWarnings(lines, result);
  return lines.join("\n");
}

// --- Annual report (årsrapport) --------------------------------------------

/**
 * Render a `report annual` payload as Danish human text — resultatopgørelse,
 * balance, årets resultat, noter-skelet and ledelsespåtegning. The payload is
 * the `AnnualReport` from `buildAnnualReport`. (#235)
 */
function renderAnnualReport(result: Record<string, unknown>): string {
  const from = asText(result.fiscalYearStart);
  const to = asText(result.fiscalYearEnd);
  const company = (typeof result.company === "object" && result.company !== null
    ? result.company
    : {}) as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(`Årsrapport (regnskabsklasse B) for regnskabsåret ${from} til ${to}`);
  if (company.name) {
    const cvr = company.cvr ? `, CVR ${asText(company.cvr)}` : "";
    lines.push(`${asText(company.name)}${cvr}`);
  }
  lines.push("");

  // Resultatopgørelse — reuse the profit-and-loss renderer's body.
  const pl = (typeof result.profitAndLoss === "object" && result.profitAndLoss !== null
    ? result.profitAndLoss
    : {}) as Record<string, unknown>;
  lines.push("Resultatopgørelse");
  lines.push("");
  const income = asArray(pl.income);
  lines.push("Indtægter:");
  if (income.length === 0) {
    lines.push("  (ingen)");
  } else {
    for (const line of income) {
      lines.push(`  ${asText(line.accountNo)} ${asText(line.name)}: ${formatKroner(line.amount)}`);
    }
  }
  lines.push(`  Indtægter i alt:               ${formatKroner(pl.totalIncome)}`);
  lines.push("");
  const expense = asArray(pl.expense);
  lines.push("Omkostninger:");
  if (expense.length === 0) {
    lines.push("  (ingen)");
  } else {
    for (const line of expense) {
      lines.push(`  ${asText(line.accountNo)} ${asText(line.name)}: ${formatKroner(line.amount)}`);
    }
  }
  lines.push(`  Omkostninger i alt:            ${formatKroner(pl.totalExpense)}`);
  lines.push("");

  const arets = typeof result.aretsResultat === "number"
    ? result.aretsResultat
    : Number(result.aretsResultat);
  if (Number.isFinite(arets) && arets > 0) {
    lines.push(`Årets resultat: overskud på ${formatKroner(arets)}`);
  } else if (Number.isFinite(arets) && arets < 0) {
    lines.push(`Årets resultat: underskud på ${formatKroner(-arets)}`);
  } else {
    lines.push("Årets resultat: 0,00 kr.");
  }
  lines.push("");

  // Balance.
  const bs = (typeof result.balanceSheet === "object" && result.balanceSheet !== null
    ? result.balanceSheet
    : {}) as Record<string, unknown>;
  lines.push(`Balance pr. ${asText(bs.asOfDate, to)}`);
  lines.push("");
  renderBalanceSection(lines, "Aktiver", bs.assets);
  lines.push("");
  renderBalanceSection(lines, "Passiver", bs.liabilities);
  lines.push("");
  renderBalanceSection(lines, "Egenkapital", bs.equity);
  lines.push(`  Periodens resultat:`.padEnd(33) + formatKroner(bs.periodResult));
  lines.push("");
  lines.push(`  Aktiver i alt:                 ${formatKroner(bs.totalAssets)}`);
  lines.push(`  Passiver og egenkapital i alt: ${formatKroner(bs.totalLiabilitiesAndEquity)}`);
  lines.push(
    bs.balanced === true
      ? "  Balancen går op (aktiver = passiver + egenkapital)."
      : "  ADVARSEL: balancen går ikke op.",
  );
  lines.push("");

  // Notes skeleton.
  const notes = asArray(result.notes);
  if (notes.length > 0) {
    lines.push("Noter:");
    for (const note of notes) {
      const flag = note.placeholder === true ? " (skabelon — udfyldes)" : "";
      lines.push(`  - ${asText(note.title)}${flag}`);
    }
    lines.push("");
  }

  // Ledelsespåtegning.
  const led = (typeof result.ledelsespategning === "object" && result.ledelsespategning !== null
    ? result.ledelsespategning
    : {}) as Record<string, unknown>;
  if (led.text) {
    lines.push("Ledelsespåtegning:");
    lines.push(`  ${asText(led.text)}`);
    if (led.placeholder === true) {
      lines.push("  (skabelon — gennemgås og godkendes af ledelsen)");
    }
    lines.push("");
  }

  if (result.disclaimer) {
    lines.push(asText(result.disclaimer));
  }
  appendWarnings(lines, result);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

// --- Backup status ---------------------------------------------------------

/**
 * Render a `system backup-status` payload as Danish human text. The payload is
 * the `BackupComplianceStatus` from `getBackupComplianceStatus`. States
 * plainly whether the weekly backup duty is met and when the next is due. (#240)
 */
function renderBackupStatus(result: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`Backup-status pr. ${asText(result.checkedAt)}`);
  lines.push("");

  const backupsFound = asCount(result.backupsFound);
  const due = result.backupDue === true;
  const hasActivity = result.hasActivitySinceBackup === true;

  if (backupsFound === 0) {
    if (hasActivity) {
      lines.push("Backup-pligten er IKKE opfyldt: der er bogført data, men ingen backup er taget endnu.");
    } else {
      lines.push("Backup-pligten er opfyldt: der er endnu ingen bogført data, der kræver backup.");
    }
  } else if (due) {
    lines.push("Backup-pligten er IKKE opfyldt: en ny backup er forfalden.");
  } else {
    lines.push("Backup-pligten er opfyldt: seneste backup dækker den nuværende bogføring.");
  }
  lines.push("");

  if (result.latestBackupId) {
    lines.push(`  Seneste backup:                ${asText(result.latestBackupId)}`);
  } else {
    lines.push("  Seneste backup:                ingen registreret");
  }
  if (result.latestBackupAt) {
    lines.push(`  Taget:                         ${asText(result.latestBackupAt)}`);
  }
  const days = result.daysSinceLatestBackup;
  if (typeof days === "number" && Number.isFinite(days)) {
    lines.push(`  Dage siden seneste backup:     ${days}`);
  }
  lines.push(
    `  Ændringer siden seneste backup: ${hasActivity ? "ja" : "nej"}`,
  );
  lines.push("");

  if (backupsFound === 0 && hasActivity) {
    // No backup taken yet, but data has been booked — the duty is due now.
    lines.push("Tag en backup nu: der er bogført data, som endnu ikke er sikkerhedskopieret.");
  } else if (result.requiredBy) {
    const verb = due ? "Næste backup skulle have været taget senest" : "Næste backup skal tages senest";
    lines.push(`${verb} ${asText(result.requiredBy)}.`);
  } else if (!hasActivity) {
    lines.push("Ingen frist: backup kræves først, når der bogføres nye data.");
  }
  lines.push("Backup-pligten er ugentlig — tag en backup mindst hver 7. dag, når der bogføres.");
  appendWarnings(lines, result);
  return lines.join("\n");
}

// --- Invoice status --------------------------------------------------------

function renderInvoiceStatus(result: Record<string, unknown>): string {
  const lines: string[] = [];
  const number = asText(result.invoiceNumber);
  lines.push(`Status for faktura ${number}`);
  lines.push("");

  const statusCode = typeof result.status === "string" ? result.status : "";
  const statusDa = INVOICE_STATUS_DA[statusCode] ?? statusCode ?? "ukendt";
  const open = typeof result.openBalance === "number" ? result.openBalance : Number(result.openBalance);

  if (statusCode === "paid") {
    lines.push("Fakturaen er fuldt betalt.");
  } else if (statusCode === "credited") {
    lines.push("Fakturaen er krediteret.");
  } else if (statusCode === "refunded") {
    lines.push("Fakturaen er refunderet.");
  } else if (statusCode === "written_off") {
    lines.push("Fakturaen er afskrevet som tab på debitorer.");
  } else if (statusCode === "overpaid") {
    lines.push(`Fakturaen er overbetalt med ${formatKroner(Number.isFinite(open) ? -open : open)}.`);
  } else if (Number.isFinite(open) && open > 0) {
    lines.push(`Der mangler at blive betalt ${formatKroner(open)} på fakturaen.`);
  } else {
    lines.push(`Fakturaen er ${statusDa}.`);
  }

  if (result.isOverdue === true) {
    const days = asCount(result.overdueDays);
    lines.push(`Fakturaen er forfalden — ${days} dage over forfaldsdato.`);
  }

  // One decisive bottom-line: an invoice may be part-paid, part-credited and
  // part-refunded at once, and the owner cannot read "still owes anything" off
  // four separate amounts. claimOpenBalance is the total still outstanding,
  // including reminder fees / interest / compensation. (#233)
  const claimOpen =
    typeof result.claimOpenBalance === "number"
      ? result.claimOpenBalance
      : Number(result.claimOpenBalance);
  const outstanding = Number.isFinite(claimOpen) ? claimOpen : open;
  if (Number.isFinite(outstanding) && outstanding > 0) {
    lines.push(`→ Udestående i alt: ${formatKroner(outstanding)} — kunden skylder stadig.`);
  } else if (Number.isFinite(outstanding) && outstanding < 0) {
    lines.push(`→ Afsluttet — kunden har ${formatKroner(-outstanding)} til gode.`);
  } else {
    lines.push("→ Afsluttet — intet udestående.");
  }

  lines.push("");
  lines.push(`  Fakturabeløb (inkl. moms):     ${formatKroner(result.grossAmount)}`);
  if (asCount(result.creditedAmount) !== 0) {
    lines.push(`  Krediteret:                    ${formatKroner(result.creditedAmount)}`);
  }
  lines.push(`  Betalt:                        ${formatKroner(result.paidAmount)}`);
  lines.push(`  Åben saldo:                    ${formatKroner(result.openBalance)}`);
  if (asCount(result.claimOpenBalance) !== 0) {
    lines.push(`  Åben saldo på krav (gebyrer):  ${formatKroner(result.claimOpenBalance)}`);
  }
  lines.push("");
  lines.push(`  Status:                        ${statusDa}`);
  if (result.effectiveDueDate) {
    lines.push(`  Forfaldsdato:                  ${asText(result.effectiveDueDate)}`);
  }
  if (result.asOfDate) {
    lines.push(`  Opgjort pr.:                   ${asText(result.asOfDate)}`);
  }

  const payments = asArray(result.payments);
  if (payments.length > 0) {
    lines.push("");
    lines.push(`Indbetalinger (${payments.length}):`);
    for (const payment of payments) {
      lines.push(
        `  - ${asText(payment.paymentDate)}: ${formatKroner(payment.amount)}` +
          (payment.note ? ` (${asText(payment.note)})` : ""),
      );
    }
  }

  const creditNotes = asArray(result.creditNotes);
  if (creditNotes.length > 0) {
    lines.push("");
    lines.push(`Kreditnotaer (${creditNotes.length}):`);
    for (const note of creditNotes) {
      lines.push(
        `  - ${asText(note.creditNoteNumber)} (${asText(note.issueDate)}): ${formatKroner(note.amount)}`,
      );
    }
  }

  const reminders = asArray(result.reminders);
  if (reminders.length > 0) {
    lines.push("");
    lines.push(`Rykkere (${reminders.length}):`);
    for (const reminder of reminders) {
      lines.push(
        `  - ${asText(reminder.reminderDate)}: gebyr ${formatKroner(reminder.feeAmount)}`,
      );
    }
  }
  appendWarnings(lines, result);
  return lines.join("\n");
}

// --- Invoice late interest (morarente) -------------------------------------

/**
 * Format a percentage with Danish decimal comma, e.g. 8.05 -> "8,05 %".
 * Non-finite/missing input yields "—".
 */
function formatPercent(value: unknown): string {
  const num = typeof value === "number" ? value : Number(value);
  if (value == null || value === "" || !Number.isFinite(num)) return "—";
  const text = (Math.round(num * 100) / 100)
    .toString()
    .replace(".", ",");
  return `${text} %`;
}

/**
 * Render an `invoice interest` / `invoice claim-interest` payload as Danish
 * human text. The payload is the `CalculateInvoiceLateInterestResult` from
 * `calculateInvoiceLateInterest` (optionally with the `claimId` /
 * `claimOpenBalance` registration fields). Shows the reference rate, the
 * statutory annual rate, the overdue window and the computed interest amount
 * — the figures that previously only appeared under `--format json`. (#250)
 */
function renderInvoiceInterest(result: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`Morarente for faktura ${asText(result.invoiceNumber)}`);
  lines.push("");

  const overdueDays = asCount(result.overdueDays);
  const interest =
    typeof result.accruedInterestAmount === "number"
      ? result.accruedInterestAmount
      : Number(result.accruedInterestAmount);
  const registered = result.claimId != null;

  if (overdueDays > 0 && Number.isFinite(interest) && interest > 0) {
    lines.push(
      `Fakturaen er ${overdueDays} dage forfalden — der er påløbet ${formatKroner(interest)} i morarente.`,
    );
  } else if (overdueDays > 0) {
    lines.push(
      `Fakturaen er ${overdueDays} dage forfalden, men der er ingen morarente at opkræve` +
        " (ingen åben saldo at forrente).",
    );
  } else {
    lines.push("Fakturaen er ikke forfalden — der er ingen morarente at opkræve.");
  }
  lines.push("");

  lines.push(`  Forfaldsdato:                  ${asText(result.effectiveDueDate)}`);
  lines.push(`  Opgjort pr.:                   ${asText(result.asOfDate)}`);
  lines.push(`  Antal forfaldne dage:          ${overdueDays}`);
  lines.push(`  Åben hovedstol:                ${formatKroner(result.principalOpenBalance)}`);
  lines.push(`  Referencesats (Nationalbanken): ${formatPercent(result.referenceRatePercent)}`);
  lines.push(
    `  Morarentesats (reference + 8 %): ${formatPercent(result.annualInterestRatePercent)}`,
  );
  lines.push(`  Påløbet morarente:             ${formatKroner(result.accruedInterestAmount)}`);

  if (registered) {
    lines.push("");
    lines.push(`Morarentekravet er registreret (krav-id ${asText(result.claimId)}).`);
    if (result.claimDate) {
      lines.push(`  Kravdato:                      ${asText(result.claimDate)}`);
    }
    if (result.claimOpenBalance !== undefined) {
      lines.push(`  Åben saldo på krav:            ${formatKroner(result.claimOpenBalance)}`);
    }
  }
  appendWarnings(lines, result);
  return lines.join("\n");
}

// --- Invoice late compensation (kompensationsbeløb) ------------------------

/**
 * Render an `invoice compensation` / `invoice claim-compensation` payload as
 * Danish human text. The payload is the `CalculateInvoiceLateCompensationResult`
 * from `calculateInvoiceLateCompensation` (optionally with the registration
 * fields). Shows whether the invoice is eligible for the statutory fixed
 * compensation for late commercial payment, the amount and a clear reason
 * — figures that previously only appeared under `--format json`. (#250)
 */
function renderInvoiceCompensation(result: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`Kompensation for sen betaling — faktura ${asText(result.invoiceNumber)}`);
  lines.push("");

  const eligible = result.eligible === true;
  const amount =
    typeof result.compensationAmountDkk === "number"
      ? result.compensationAmountDkk
      : Number(result.compensationAmountDkk);
  const registered = result.claimId != null;

  if (eligible && Number.isFinite(amount) && amount > 0) {
    lines.push(
      `Fakturaen er berettiget til ${formatKroner(amount)} i fast kompensation for sen betaling.`,
    );
  } else {
    lines.push("Fakturaen er IKKE berettiget til kompensation for sen betaling.");
    lines.push(`  Årsag: ${reasonInDanish(result.reason)}`);
  }
  lines.push("");

  lines.push(`  Forfaldsdato:                  ${asText(result.effectiveDueDate)}`);
  lines.push(`  Opgjort pr.:                   ${asText(result.asOfDate)}`);
  lines.push(`  Antal forfaldne dage:          ${asCount(result.overdueDays)}`);
  lines.push(`  Åben hovedstol:                ${formatKroner(result.principalOpenBalance)}`);
  lines.push(
    `  Erhvervshandel (CVR/VAT):      ${result.isCommercialTransaction === true ? "ja" : "nej"}`,
  );
  lines.push(`  Berettiget:                    ${eligible ? "ja" : "nej"}`);
  lines.push(`  Kompensationsbeløb:            ${formatKroner(result.compensationAmountDkk)}`);

  if (registered) {
    lines.push("");
    lines.push(`Kompensationskravet er registreret (krav-id ${asText(result.claimId)}).`);
    if (result.claimDate) {
      lines.push(`  Kravdato:                      ${asText(result.claimDate)}`);
    }
    if (result.claimOpenBalance !== undefined) {
      lines.push(`  Åben saldo på krav:            ${formatKroner(result.claimOpenBalance)}`);
    }
  }
  appendWarnings(lines, result);
  return lines.join("\n");
}

/**
 * Translate the machine-readable `reason` from the compensation core into a
 * plain-Danish explanation for the human renderer. Falls back to the raw
 * reason string for any reason without a dedicated translation.
 */
function reasonInDanish(reason: unknown): string {
  const text = typeof reason === "string" ? reason : "";
  if (text === "eligible" || text === "registered") {
    return "fakturaen er berettiget";
  }
  if (/commercial transaction not proven/i.test(text)) {
    return "købers CVR/VAT-nummer mangler — handlen kan ikke dokumenteres som erhvervshandel";
  }
  if (/no collectible open balance/i.test(text)) {
    return "fakturaen har ingen åben saldo at opkræve kompensation for";
  }
  if (/not overdue/i.test(text)) {
    return "fakturaen er ikke forfalden på den valgte dato";
  }
  if (/predates statutory compensation start date/i.test(text)) {
    return "fakturaen ligger før den lovbestemte ikrafttrædelsesdato for kompensation (1. marts 2013)";
  }
  return text.length > 0 ? text : "ukendt";
}

// --- Invoice payload validation --------------------------------------------

/**
 * Render an `invoice validate` payload as Danish human text. The payload is
 * the `InvoiceValidationResult` from `validateInvoice`. Both verdicts are
 * rendered in full: a valid payload states it plainly, an invalid payload
 * lists every concrete rejection reason — instead of a blank command
 * description with no result. (#250)
 */
function renderInvoiceValidate(result: Record<string, unknown>): string {
  const lines: string[] = [];
  const valid = result.ok !== false;
  lines.push("Fakturavalidering");
  lines.push("");

  if (valid) {
    lines.push("Fakturaen er gyldig og kan udstedes.");
  } else {
    const errors = asStringArray(result.errors);
    lines.push(
      `Fakturaen er IKKE gyldig — ${errors.length} ${errors.length === 1 ? "fejl" : "fejl"} skal rettes:`,
    );
    if (errors.length === 0) {
      lines.push("  → Valideringen fejlede uden en specifik fejlbesked.");
    } else {
      for (const error of errors) lines.push(`  → ${error}`);
    }
  }
  lines.push("");

  const invoiceTypeDa =
    result.invoiceType === "simplified"
      ? "forenklet faktura"
      : result.invoiceType === "full"
        ? "fuld faktura"
        : asText(result.invoiceType);
  const vatTreatmentDa = VAT_TREATMENT_DA[String(result.vatTreatment)] ?? asText(result.vatTreatment);
  lines.push(`  Fakturatype:                   ${invoiceTypeDa}`);
  lines.push(`  Momsbehandling:                ${vatTreatmentDa}`);

  const rules = asStringArray(result.appliedRules);
  if (rules.length > 0) {
    lines.push(`  Anvendte regler:               ${rules.join(", ")}`);
  }
  appendWarnings(lines, result);
  return lines.join("\n");
}

/** Danish labels for the invoice VAT treatments. */
const VAT_TREATMENT_DA: Record<string, string> = {
  standard: "standardmoms",
  domestic_reverse_charge: "omvendt betalingspligt (indenlandsk)",
  foreign_reverse_charge: "omvendt betalingspligt (udenlandsk)",
};

// --- Invoice create (write command, guided path) ---------------------------

/**
 * Render an `invoice create` result as Danish human text. The payload is the
 * `IssueInvoiceResult` enriched with `computed` (line totals, net, VAT, gross)
 * from `src/cli/invoice.ts`. (#266, #268)
 *
 * Two bugs are addressed here:
 *  - #268: the write command used to fall through to the generic renderer,
 *    which printed the long command DESCRIPTION as the heading and English
 *    field labels ("Invoice Number", "Document Id") and dropped the figures.
 *    This renderer gives a short Danish heading, Danish labels and the
 *    amounts/VAT/dates/paths that matter.
 *  - #266: `invoice create` builds and issues the invoice but does NOT post it
 *    to the ledger — no revenue / output-VAT posting. The output must make
 *    that gap impossible to miss, so it states plainly that `invoice post` is
 *    still required.
 */
function renderInvoiceCreate(result: Record<string, unknown>): string {
  if (result.ok === false) {
    return buildHumanError("Faktura kunne ikke udstedes", result).join("\n");
  }
  const computed = (typeof result.computed === "object" && result.computed !== null
    ? result.computed
    : {}) as Record<string, unknown>;
  const number = asText(result.invoiceNumber);
  const lines: string[] = [];
  lines.push(`Faktura ${number} er udstedt`);
  lines.push("");

  lines.push(`  Fakturanummer:                 ${number}`);
  if (result.documentId != null) {
    lines.push(`  Bilags-id:                     ${asText(result.documentId)}`);
  }
  lines.push(`  Nettobeløb (ekskl. moms):      ${formatKroner(computed.netAmount)}`);
  const ratePercent = computed.vatRatePercent ?? computed.vatRate;
  if (ratePercent != null) {
    const pct =
      typeof computed.vatRatePercent === "number"
        ? computed.vatRatePercent
        : typeof computed.vatRate === "number"
          ? computed.vatRate * 100
          : Number(ratePercent);
    lines.push(`  Momssats:                      ${formatPercent(pct)}`);
  }
  lines.push(`  Momsbeløb:                     ${formatKroner(computed.vatAmount)}`);
  lines.push(`  Fakturabeløb (inkl. moms):     ${formatKroner(computed.grossAmount)}`);
  if (result.storedPath) {
    lines.push(`  Gemt faktura (JSON):           ${asText(result.storedPath)}`);
  }
  if (result.pdfStoredPath) {
    lines.push(`  Faktura-PDF:                   ${asText(result.pdfStoredPath)}`);
  }
  lines.push("");
  // #266: the decisive line — the invoice is issued but NOT yet booked.
  lines.push(
    `Fakturaen er udstedt, men endnu IKKE bogført — kør \`invoice post ${number}\``,
  );
  lines.push(
    "for at få den i regnskabet (salgsindtægt og udgående moms). Indtil da indgår",
  );
  lines.push("den ikke i din moms eller dit resultat.");
  appendWarnings(lines, result);
  return lines.join("\n");
}

/** Write-command kinds with a dedicated Danish human renderer. (#266, #268) */
export type HumanWriteKind = "invoice-create";

/**
 * Emit a write-command `result` either as the byte-stable agent JSON or as a
 * Danish human rendering, depending on `format`. The `--format json` path is
 * exactly `JSON.stringify(result, null, 2)` — unchanged from `emitResult` — so
 * agents see no difference. Sets `process.exitCode = 1` on `ok: false`. (#268)
 */
export function emitHumanWrite(
  kind: HumanWriteKind,
  result: Record<string, unknown>,
  format: OutputFormat,
): void {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const human = kind === "invoice-create" ? renderInvoiceCreate(result) : null;
    if (human !== null) {
      if (result.ok === false) console.error(human);
      else console.log(human);
    } else {
      printStructuredResult(kind, result, format);
    }
  }
  if (result.ok === false) process.exitCode = 1;
}

// --- Exceptions list -------------------------------------------------------

function renderExceptionsList(result: Record<string, unknown>): string {
  const rows = asArray(result.rows);
  const lines: string[] = [];
  if (rows.length === 0) {
    lines.push("Ingen exceptions i køen for det valgte filter.");
    return lines.join("\n");
  }
  const open = rows.filter((row) => row.status === "open").length;
  lines.push(
    `Exceptions-kø: ${rows.length} sag${rows.length === 1 ? "" : "er"}` +
      (open > 0 ? ` (${open} åben${open === 1 ? "" : "e"})` : ""),
  );
  lines.push("");
  for (const row of rows) {
    const severity = SEVERITY_DA[String(row.severity)] ?? asText(row.severity);
    const status = EXCEPTION_STATUS_DA[String(row.status)] ?? asText(row.status);
    lines.push(`#${asText(row.id)} — ${asText(row.message)}`);
    lines.push(`  Type: ${asText(row.type)} | Alvorlighed: ${severity} | Status: ${status}`);
    if (row.requiredAction) {
      lines.push(`  Påkrævet handling: ${asText(row.requiredAction)}`);
    }
    const refs: string[] = [];
    if (row.relatedBankTransactionId != null) {
      refs.push(`banktransaktion ${asText(row.relatedBankTransactionId)}`);
    }
    if (row.relatedDocumentId != null) {
      refs.push(`bilag ${asText(row.relatedDocumentId)}`);
    }
    if (refs.length > 0) lines.push(`  Vedrører: ${refs.join(", ")}`);
    if (row.archived === true) lines.push("  (i arkiveret/lukket periode)");
    if (row.status === "resolved" && row.resolvedAt) {
      lines.push(
        `  Løst ${asText(row.resolvedAt)}` +
          (row.resolvedBy ? ` af ${asText(row.resolvedBy)}` : ""),
      );
    }
    lines.push("");
  }
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

// --- Trial balance ---------------------------------------------------------

function renderTrialBalance(result: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(
    `Saldobalance for perioden ${asText(result.periodStart)} til ${asText(result.periodEnd)}`,
  );
  lines.push("");
  const accounts = asArray(result.accounts);
  if (accounts.length === 0) {
    lines.push("Ingen konti har bevægelser i perioden.");
  } else {
    for (const account of accounts) {
      lines.push(
        `  ${asText(account.accountNo)} ${asText(account.name)}`,
      );
      lines.push(
        `      Debet ${formatKroner(account.debit)} | Kredit ${formatKroner(account.credit)} | Saldo ${formatKroner(account.balance)}`,
      );
    }
  }
  lines.push("");
  lines.push(`  Debet i alt:                   ${formatKroner(result.totalDebit)}`);
  lines.push(`  Kredit i alt:                  ${formatKroner(result.totalCredit)}`);
  lines.push(
    result.balanced === true
      ? "  Saldobalancen går op (debet = kredit)."
      : "  ADVARSEL: saldobalancen går ikke op (debet ≠ kredit).",
  );
  appendWarnings(lines, result);
  return lines.join("\n");
}

// --- Profit and loss -------------------------------------------------------

function renderProfitAndLoss(result: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(
    `Resultatopgørelse for perioden ${asText(result.periodStart)} til ${asText(result.periodEnd)}`,
  );
  lines.push("");
  const income = asArray(result.income);
  lines.push("Indtægter:");
  if (income.length === 0) {
    lines.push("  (ingen)");
  } else {
    for (const line of income) {
      lines.push(`  ${asText(line.accountNo)} ${asText(line.name)}: ${formatKroner(line.amount)}`);
    }
  }
  lines.push(`  Indtægter i alt:               ${formatKroner(result.totalIncome)}`);
  lines.push("");
  const expense = asArray(result.expense);
  lines.push("Omkostninger:");
  if (expense.length === 0) {
    lines.push("  (ingen)");
  } else {
    for (const line of expense) {
      lines.push(`  ${asText(line.accountNo)} ${asText(line.name)}: ${formatKroner(line.amount)}`);
    }
  }
  lines.push(`  Omkostninger i alt:            ${formatKroner(result.totalExpense)}`);
  lines.push("");
  const profit = typeof result.result === "number" ? result.result : Number(result.result);
  if (Number.isFinite(profit) && profit > 0) {
    lines.push(`Periodens resultat: overskud på ${formatKroner(profit)}`);
  } else if (Number.isFinite(profit) && profit < 0) {
    lines.push(`Periodens resultat: underskud på ${formatKroner(-profit)}`);
  } else {
    lines.push("Periodens resultat: 0,00 kr.");
  }
  appendWarnings(lines, result);
  return lines.join("\n");
}

// --- Balance sheet ---------------------------------------------------------

function renderBalanceSection(lines: string[], heading: string, section: unknown): void {
  const data = (typeof section === "object" && section !== null ? section : {}) as Record<string, unknown>;
  lines.push(`${heading}:`);
  const sectionLines = asArray(data.lines);
  if (sectionLines.length === 0) {
    lines.push("  (ingen)");
  } else {
    for (const line of sectionLines) {
      lines.push(`  ${asText(line.accountNo)} ${asText(line.name)}: ${formatKroner(line.amount)}`);
    }
  }
  lines.push(`  ${heading} i alt:`.padEnd(33) + formatKroner(data.total));
}

function renderBalanceSheet(result: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`Balance pr. ${asText(result.asOfDate)}`);
  lines.push("");
  renderBalanceSection(lines, "Aktiver", result.assets);
  lines.push("");
  renderBalanceSection(lines, "Passiver", result.liabilities);
  lines.push("");
  renderBalanceSection(lines, "Egenkapital", result.equity);
  lines.push(`  Periodens resultat:`.padEnd(33) + formatKroner(result.periodResult));
  lines.push("");
  lines.push(`  Aktiver i alt:                 ${formatKroner(result.totalAssets)}`);
  lines.push(`  Passiver og egenkapital i alt: ${formatKroner(result.totalLiabilitiesAndEquity)}`);
  lines.push(
    result.balanced === true
      ? "  Balancen går op (aktiver = passiver + egenkapital)."
      : "  ADVARSEL: balancen går ikke op.",
  );
  appendWarnings(lines, result);
  return lines.join("\n");
}

// --- Retention status ------------------------------------------------------

const RETENTION_TABLE_DA: Record<string, string> = {
  documents: "Bilag",
  journal_entries: "Finansposteringer",
  bank_transactions: "Banktransaktioner",
};

function renderRetentionStatus(result: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`Opbevaringsstatus pr. ${asText(result.asOf)}`);
  lines.push("");
  const rows = asArray(result.rows);
  if (rows.length === 0) {
    lines.push("Ingen materiale registreret.");
  } else {
    for (const row of rows) {
      const name = RETENTION_TABLE_DA[String(row.table)] ?? asText(row.table);
      lines.push(`${name}:`);
      lines.push(`  I alt: ${asCount(row.total)} | Udløbet: ${asCount(row.expired)}`);
      if (row.nextExpiry) lines.push(`  Næste udløb: ${asText(row.nextExpiry)}`);
      if (row.oldestExpired) lines.push(`  Ældste udløbne: ${asText(row.oldestExpired)}`);
      lines.push("");
    }
    if (lines[lines.length - 1] === "") lines.pop();
  }
  appendWarnings(lines, result);
  return lines.join("\n");
}

// --- Contact lists (customers / vendors) -----------------------------------

/**
 * Render a `customer list` / `vendor list` payload as Danish human-readable
 * text. The payload is the `{ ok, count, rows }` object from
 * `listCustomers` / `listVendors`.
 */
export function renderContactList(
  result: Record<string, unknown>,
  heading: string,
  emptyMessage: string,
): string {
  if (result.ok === false) {
    return buildHumanError(heading, result).join("\n");
  }
  const rows = asArray(result.rows);
  const lines: string[] = [`${heading} (${rows.length})`];
  if (rows.length === 0) {
    lines.push(emptyMessage);
    return lines.join("\n");
  }
  for (const row of rows) {
    lines.push("");
    lines.push(`#${asText(row.id)} — ${asText(row.name)}`);
    if (row.vatOrCvr) lines.push(`  CVR/moms-nr.: ${asText(row.vatOrCvr)}`);
    if (row.address) lines.push(`  Adresse: ${asText(row.address)}`);
    if (row.email) lines.push(`  E-mail: ${asText(row.email)}`);
    if (row.phone) lines.push(`  Telefon: ${asText(row.phone)}`);
    if (row.eanNumber) lines.push(`  EAN-nummer: ${asText(row.eanNumber)}`);
    if (typeof row.paymentTermsDays === "number") {
      lines.push(`  Betalingsbetingelser: ${row.paymentTermsDays} dage`);
    }
    if (row.defaultCurrency) lines.push(`  Standardvaluta: ${asText(row.defaultCurrency)}`);
    if (row.defaultExpenseAccount) {
      lines.push(`  Standard omkostningskonto: ${asText(row.defaultExpenseAccount)}`);
    }
    if (row.defaultVatTreatment) {
      lines.push(`  Standard momsbehandling: ${asText(row.defaultVatTreatment)}`);
    }
    if (row.notes) lines.push(`  Noter: ${asText(row.notes)}`);
    if (row.archived === true) lines.push("  (arkiveret)");
  }
  return lines.join("\n");
}

// --- Bank reconciliation ---------------------------------------------------

function renderBankReconciliation(result: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(
    `Bankafstemning for perioden ${asText(result.periodStart)} til ${asText(result.periodEnd)}`,
  );
  lines.push("");
  const matchedCount = asCount(result.matchedCount);
  const unmatchedCount = asCount(result.unmatchedCount);
  lines.push(
    `${matchedCount} afstemt${matchedCount === 1 ? "" : "e"} og ${unmatchedCount} uafstemt${unmatchedCount === 1 ? "" : "e"} transaktion${matchedCount + unmatchedCount === 1 ? "" : "er"}.`,
  );
  lines.push(`  Afstemt beløb i alt:           ${formatKroner(result.matchedAmountTotal)}`);

  // A single netted "Uafstemt beløb i alt" hides the real workload: an
  // outflow of -1.250 and an inflow of +2.500 net to +1.250, masking that
  // there are two rows to reconcile. Show inflows and outflows separately
  // so an owner sees both the count and the gross size of each side.
  const unmatchedRows = asArray(result.unmatched);
  let inflowTotal = 0;
  let inflowCount = 0;
  let outflowTotal = 0;
  let outflowCount = 0;
  for (const row of unmatchedRows) {
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;
    if (amount < 0) {
      outflowTotal += amount;
      outflowCount += 1;
    } else {
      inflowTotal += amount;
      inflowCount += 1;
    }
  }
  lines.push(
    `  Uafstemte indbetalinger (${inflowCount}):  ${formatKroner(inflowTotal)}`,
  );
  lines.push(
    `  Uafstemte udbetalinger (${outflowCount}):   ${formatKroner(-outflowTotal)}`,
  );

  const matched = asArray(result.matched);
  if (matched.length > 0) {
    lines.push("");
    lines.push("Afstemte transaktioner:");
    for (const row of matched) {
      lines.push(
        `  - ${asText(row.transactionDate)} | ${formatKroner(row.amount)} | ${asText(row.text)} → postering ${asText(row.journalEntryNo)}`,
      );
    }
  }

  const unmatched = unmatchedRows;
  if (unmatched.length > 0) {
    lines.push("");
    lines.push("Uafstemte transaktioner:");
    for (const row of unmatched) {
      lines.push(
        `  - ${asText(row.transactionDate)} | ${formatKroner(row.amount)} | ${asText(row.text)}`,
      );
    }
  }

  if (matched.length === 0 && unmatched.length === 0) {
    lines.push("");
    lines.push("Ingen transaktioner for det valgte filter.");
  }
  appendWarnings(lines, result);
  return lines.join("\n");
}
