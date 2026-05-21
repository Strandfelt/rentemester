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
  | "invoice-status"
  | "exceptions-list"
  | "report-trial-balance"
  | "report-profit-loss"
  | "report-balance"
  | "retention-status"
  | "reconcile-bank";

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
  if (result.ok === false) {
    return buildHumanError(humanReportTitle(kind), result).join("\n");
  }
  switch (kind) {
    case "vat-report":
      return renderVatReport(result);
    case "invoice-status":
      return renderInvoiceStatus(result);
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
    case "invoice-status":
      return "Fakturastatus";
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
    lines.push(`Periodens resultat: overskud på ${formatKroner(profit)}.`);
  } else if (Number.isFinite(profit) && profit < 0) {
    lines.push(`Periodens resultat: underskud på ${formatKroner(-profit)}.`);
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
  lines.push(`  Uafstemt beløb i alt:          ${formatKroner(result.unmatchedAmountTotal)}`);

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

  const unmatched = asArray(result.unmatched);
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
