#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureCompanyDirs, companyPaths } from "./core/paths";
import { openDb, migrate } from "./core/db";
import { postJournalEntry, reverseJournalEntry, seedAccounts, verifyAuditChain } from "./core/ledger";
import { validateInvoice } from "./core/invoice";
import { ingestDocument } from "./core/documents";
import { importBankCsv } from "./core/bank";
import { suggestBankMatches } from "./core/bank-suggest-matches";
import { buildVatReport, postEuServiceReverseChargePurchase, postRepresentationPurchase } from "./core/vat";
import { bookExpenseFromBank } from "./core/expense-booking";
import { buildBankReconciliationReport, listBankTransactions } from "./core/reconciliation";
import { issueInvoice } from "./core/issued-invoices";
import { renderIssuedInvoicePdf } from "./core/invoice-pdf";
import { applyInvoicePayment, getInvoiceStatus } from "./core/invoice-payments";
import { buildInvoiceList, buildOverdueInvoiceList, findInvoices } from "./core/invoice-list";
import { postIssuedInvoiceToLedger } from "./core/invoice-booking";
import { settleInvoiceFromBank } from "./core/invoice-settlement";
import { settleInvoiceClaimsFromBank } from "./core/invoice-claim-settlement";
import { issueCreditNote } from "./core/credit-notes";
import { refundInvoiceToBank } from "./core/invoice-refunds";
import { calculateInvoiceLateInterest, postInvoiceLateInterestToLedger, registerInvoiceLateInterest } from "./core/invoice-interest";
import { calculateInvoiceLateCompensation, postInvoiceLateCompensationToLedger, registerInvoiceLateCompensation } from "./core/invoice-compensation";
import { postInvoiceReminderToLedger, registerInvoiceReminder } from "./core/invoice-reminders";
import { writeOffInvoiceBadDebt } from "./core/invoice-bad-debt";
import { createSystemBackup, getBackupComplianceStatus } from "./core/system-backups";
import { exportAuthorityPackage } from "./core/authority-export";
import { restoreSystemBackup } from "./core/system-restore";
import { closeAccountingPeriod } from "./core/periods";
import { parseCliArgs } from "./cli-args";
import { resolveOutputFormat, printStructuredResult } from "./cli-format";
import { getCommandSpec, renderCommandHelp, renderGlobalUsage, validateCommandFlags } from "./cli-meta";
import { normalizeCvr, normalizeFiscalYearLabelStrategy, normalizeFiscalYearStartMonth } from "./core/company";
import { buildRetentionStatusReport } from "./core/retention";
import { validateVatAgainstVies } from "./core/vies";
import { listExceptions, recordException, resolveException, syncUnmatchedBankTransactionExceptions } from "./core/exceptions";

const parsedArgs = parseCliArgs(Bun.argv);

function arg(name: string, fallback?: string) {
  const value = parsedArgs.flags.get(name);
  return typeof value === "string" ? value : fallback;
}
function hasFlag(name: string) {
  return parsedArgs.flags.has(name);
}
function resolveInvoiceDocumentId(db: ReturnType<typeof openDb>) {
  const documentId = Number(arg("--document-id"));
  if (Number.isInteger(documentId) && documentId > 0) return documentId;
  const invoiceNumber = arg("--invoice-number")?.trim();
  if (invoiceNumber) {
    const row = db.query(`SELECT id FROM documents WHERE document_type = 'issued_invoice' AND invoice_no = ? LIMIT 1`).get(invoiceNumber) as { id: number } | null;
    return row?.id ?? null;
  }
  return null;
}
function resolveJournalEntryId(db: ReturnType<typeof openDb>) {
  const entryId = Number(arg("--entry-id"));
  if (Number.isInteger(entryId) && entryId > 0) return entryId;
  const entryNo = arg("--entry-no")?.trim();
  if (entryNo) {
    const row = db.query(`SELECT id FROM journal_entries WHERE entry_no = ? LIMIT 1`).get(entryNo) as { id: number } | null;
    return row?.id ?? null;
  }
  return null;
}
function findInvoiceDocumentIdByNumber(db: ReturnType<typeof openDb>, invoiceNumber?: string | null) {
  const value = invoiceNumber?.trim();
  if (!value) return null;
  const row = db.query(`SELECT id FROM documents WHERE document_type = 'issued_invoice' AND invoice_no = ? LIMIT 1`).get(value) as { id: number } | null;
  return row?.id ?? null;
}
function withResolvedInvoicePayload<T extends Record<string, unknown>>(
  db: ReturnType<typeof openDb>,
  payload: T,
  idKey: keyof T,
  numberKey: keyof T,
) {
  if (Number.isInteger(payload[idKey] as number) && Number(payload[idKey]) > 0) return payload;
  const resolved = findInvoiceDocumentIdByNumber(db, payload[numberKey] as string | undefined);
  if (!resolved) return payload;
  return { ...payload, [idKey]: resolved };
}
function trimToNull(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
function companyRoot() { return arg("--company", process.env.RENTEMESTER_COMPANY ?? "/company")!; }
const cliActor = trimToNull(arg("--actor"));
const cliActorVia = trimToNull(arg("--actor-via"));
const MUTATING_COMMANDS = new Set([
  "customer validate-vat",
  "system backup",
  "system restore-backup",
  "system export-authority",
  "invoice issue",
  "invoice render",
  "invoice credit-note",
  "invoice post",
  "invoice settle-bank",
  "invoice settle-claim-bank",
  "invoice write-off-bad-debt",
  "invoice refund-bank",
  "invoice apply-payment",
  "invoice remind",
  "invoice post-reminder",
  "invoice claim-interest",
  "invoice post-interest",
  "invoice claim-compensation",
  "invoice post-compensation",
  "documents ingest",
  "bank import",
  "expense book",
  "vat post-eu-service-purchase",
  "vat post-representation-purchase",
  "period close",
  "journal post",
  "journal reverse",
  "exceptions resolve",
]);
function isCanonicalActorId(value: string) {
  return /^(user|agent|system):\S.+$/.test(value);
}
function loadActorAllowlist(root: string) {
  const policyPath = join(companyPaths(root).config, "policy.yaml");
  if (!existsSync(policyPath)) return new Set<string>();
  const allowlist = new Set<string>();
  let inActorAllowlist = false;
  let section: string | null = null;
  for (const rawLine of readFileSync(policyPath, "utf8").split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    if (!inActorAllowlist) {
      if (trimmed === "actor_allowlist:") inActorAllowlist = true;
      continue;
    }
    if (indent === 0) break;
    if (indent === 2 && trimmed.endsWith(":")) {
      section = trimmed.slice(0, -1);
      continue;
    }
    const item = rawLine.match(/^\s*-\s*(.+?)\s*$/)?.[1]?.trim();
    if (!item) continue;
    const value = item.replace(/^['"]|['"]$/g, "");
    if (section === "users") allowlist.add(value.startsWith("user:") ? value : `user:${value}`);
    else if (section === "agents") allowlist.add(value.startsWith("agent:") ? value : `agent:${value}`);
    else if (section === "systems") allowlist.add(value.startsWith("system:") ? value : `system:${value}`);
    else allowlist.add(value);
  }
  return allowlist;
}
function inferredMutationActor() {
  return trimToNull(process.env.OPENCLAW_AGENT ? `agent:${process.env.OPENCLAW_AGENT}` : null)
    ?? trimToNull(process.env.RENTEMESTER_AGENT ? `agent:${process.env.RENTEMESTER_AGENT}` : null)
    ?? trimToNull(process.env.RENTEMESTER_USER ? `user:${process.env.RENTEMESTER_USER}` : null)
    ?? trimToNull(process.env.USER ? `user:${process.env.USER}` : null)
    ?? trimToNull(process.env.LOGNAME ? `user:${process.env.LOGNAME}` : null);
}
function enforceMutationActorPolicy(commandKey: string) {
  if (!MUTATING_COMMANDS.has(commandKey)) return;
  const explicitActor = cliActor ?? trimToNull(process.env.RENTEMESTER_ACTOR);
  if (explicitActor) {
    if (!isCanonicalActorId(explicitActor)) {
      fatal("explicit actor must use canonical format user:<id>, agent:<id>, or system:<id>");
    }
    const allowlist = loadActorAllowlist(companyRoot());
    if (!allowlist.has(explicitActor)) {
      fatal(`actor '${explicitActor}' is not in config/policy.yaml actor_allowlist; add it or run without --actor`);
    }
    process.env.RENTEMESTER_ACTOR = explicitActor;
    if (cliActorVia) process.env.RENTEMESTER_ACTOR_VIA = cliActorVia;
    else if (!trimToNull(process.env.RENTEMESTER_ACTOR_VIA)) process.env.RENTEMESTER_ACTOR_VIA = "rentemester-cli";
    return;
  }
  if (!inferredMutationActor()) {
    fatal("actor required for mutations: pass --actor <user:...|agent:...|system:...> or run with USER/LOGNAME/OPENCLAW_AGENT set");
  }
}
function usage() {
  console.log(renderGlobalUsage());
}
function fatal(message: string): never {
  console.error(message);
  process.exit(2);
}
function emitResult(commandLabel: string, result: Record<string, unknown>, outputFormat: "json" | "human") {
  printStructuredResult(commandLabel, result, outputFormat);
  if (result.ok === false) process.exitCode = 1;
}
function parseOptionalNumber(flagName: string) {
  const value = arg(flagName);
  if (value === undefined) return { ok: true as const, value: undefined };
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return { ok: false as const, error: `${flagName} must be numeric when present` };
  return { ok: true as const, value: parsed };
}
function renderInvoiceRowsHuman(title: string, rows: any[], emptyMessage: string) {
  console.log(title);
  if (rows.length === 0) {
    console.log(emptyMessage);
    return;
  }
  console.table(rows.map((row) => ({
    invoiceNumber: row.invoiceNumber,
    customerName: row.customerName,
    invoiceDate: row.invoiceDate,
    effectiveDueDate: row.effectiveDueDate,
    grossAmount: row.grossAmount,
    openBalance: row.openBalance,
    status: row.status,
    overdueDays: row.overdueDays,
  })));
}
function renderBankSuggestionsHuman(rows: any[]) {
  if (rows.length === 0) {
    console.log("No unmatched bank transactions for current filter.");
    return;
  }
  for (const row of rows) {
    console.log(`Bank transaction ${row.bankTransactionId} | ${row.date} | ${row.amount} ${row.currency} | ${row.text}`);
    if (row.suggestions.length === 0) {
      console.log("  No deterministic suggestions.");
      continue;
    }
    console.table(row.suggestions.map((suggestion: any) => ({
      kind: suggestion.kind,
      documentId: suggestion.documentId,
      invoiceNo: suggestion.invoiceNo,
      supplierName: suggestion.supplierName ?? null,
      customerName: suggestion.customerName ?? null,
      confidence: suggestion.confidence,
      reasons: suggestion.reasons.join("; "),
    })));
  }
}

const [cmd, sub] = parsedArgs.positionals;
const commandSpec = getCommandSpec(cmd, sub);
const outputFormat = resolveOutputFormat(parsedArgs.flags);
const commandKey = [cmd, sub].filter(Boolean).join(" ");

if (parsedArgs.errors.length > 0) {
  fatal(parsedArgs.errors.join("\n"));
}
if (outputFormat === null) fatal("--format must be either json or human");
const flagErrors = validateCommandFlags(cmd, sub, parsedArgs.flags.keys());
if (flagErrors.length > 0) fatal(flagErrors.join("\n"));
if (hasFlag("--example")) {
  if (!commandSpec?.examplePath) fatal(`No example is registered for ${cmd}${sub ? ` ${sub}` : ""}`);
  process.stdout.write(readFileSync(commandSpec.examplePath, "utf8"));
  process.exit(0);
}

enforceMutationActorPolicy(commandKey);

if (!cmd || cmd === "help") usage();
else if (hasFlag("--help")) {
  if (commandSpec) console.log(renderCommandHelp(commandSpec));
  else usage();
}
else if (cmd === "init") {
  const root = companyRoot();
  const p = ensureCompanyDirs(root);
  const db = openDb(p.db); migrate(db); seedAccounts(db);
  const cvr = normalizeCvr(arg("--cvr"));
  const fiscalYearStartMonth = normalizeFiscalYearStartMonth(arg("--fiscal-year-start-month")) ?? 1;
  const fiscalYearLabelStrategy = normalizeFiscalYearLabelStrategy(arg("--fiscal-year-label-strategy")) ?? "end-year";
  if (arg("--fiscal-year-start-month") && !normalizeFiscalYearStartMonth(arg("--fiscal-year-start-month"))) {
    console.error("--fiscal-year-start-month must be an integer between 1 and 12");
    process.exit(2);
  }
  if (arg("--fiscal-year-label-strategy") && !normalizeFiscalYearLabelStrategy(arg("--fiscal-year-label-strategy"))) {
    console.error("--fiscal-year-label-strategy must be one of end-year, start-year, span");
    process.exit(2);
  }
  db.query(
    `INSERT INTO companies (id, name, cvr, fiscal_year_start_month, fiscal_year_label_strategy)
     VALUES (1, 'Rentemester company', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       cvr = excluded.cvr,
       fiscal_year_start_month = excluded.fiscal_year_start_month,
       fiscal_year_label_strategy = excluded.fiscal_year_label_strategy`
  ).run(cvr, fiscalYearStartMonth, fiscalYearLabelStrategy);
  const policy = join(p.config, "policy.yaml");
  if (!existsSync(policy)) writeFileSync(policy, `company_policy:\n  country: DK\n  currency: DKK\n  allow_direct_sql_write: false\n  block_if_uncertain: true\n`);
  db.run("INSERT INTO audit_log (event_type, entity_type, message) VALUES ('init','company','Company volume initialized')");
  console.log(`Initialized Rentemester company at ${root}`);
  console.log(`Ledger: ${p.db}`);
  db.close();
}
else if (cmd === "system" && sub === "healthcheck") {
  const p = companyPaths(companyRoot());
  const checks = [
    ["company_root", existsSync(p.root)], ["data_dir", existsSync(p.data)], ["ledger", existsSync(p.db)], ["documents", existsSync(p.documentsInbox)], ["config", existsSync(p.config)]
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? "OK" : "FAIL"} ${name}`); if (!pass) ok = false; }
  if (!ok) process.exit(1);
}
else if (cmd === "system" && sub === "backup") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = createSystemBackup(db, companyRoot(), { createdAt: arg("--at") });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "system" && sub === "backup-status") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = getBackupComplianceStatus(db, companyRoot(), arg("--as-of"));
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "system" && sub === "restore-backup") {
  const backupDir = arg("--backup-dir");
  const targetCompanyRoot = arg("--target-company");
  if (!backupDir || !targetCompanyRoot) {
    console.error("Missing required --backup-dir <dir> or --target-company <path>");
    process.exit(2);
  }
  const result = restoreSystemBackup({ backupDir, targetCompanyRoot, verificationKeyPath: arg("--verify-key") ?? undefined });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
}
else if (cmd === "system" && sub === "export-authority") {
  const from = arg("--from");
  const to = arg("--to");
  const outputDir = arg("--out");
  if (!from || !to || !outputDir) {
    console.error("Missing required --from <YYYY-MM-DD>, --to <YYYY-MM-DD>, or --out <dir>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = exportAuthorityPackage(db, companyRoot(), {
    periodStart: from,
    periodEnd: to,
    outputDir,
    requestedAt: arg("--requested-at"),
    requester: arg("--requester"),
  });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "audit" && sub === "verify") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const r = verifyAuditChain(db);
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), r as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "accounts" && sub === "list") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const rows = db.query("SELECT account_no, name, type, default_vat_code FROM accounts ORDER BY account_no").all();
  console.table(rows);
  db.close();
}
else if (cmd === "customer" && sub === "validate-vat") {
  const cvr = arg("--cvr");
  if (!cvr) {
    console.error("Missing required --cvr <EU-VAT>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = await validateVatAgainstVies(db, cvr);
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "exceptions" && sub === "list") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = listExceptions(db, { status: (arg("--status") as any) ?? undefined });
  if (outputFormat === "json") emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  else if (result.ok) console.table(result.rows.map((row: any) => ({
    id: row.id,
    type: row.type,
    severity: row.severity,
    status: row.status,
    relatedBankTransactionId: row.relatedBankTransactionId,
    relatedDocumentId: row.relatedDocumentId,
    message: row.message,
    requiredAction: row.requiredAction,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  })));
  else console.error(result.errors.join("\n"));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "exceptions" && sub === "resolve") {
  const id = Number(arg("--id"));
  if (!Number.isInteger(id) || id <= 0) {
    console.error("Missing required --id <n>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = resolveException(db, {
    id,
    note: arg("--note") ?? undefined,
    resolvedBy: cliActor ?? process.env.RENTEMESTER_ACTOR ?? inferredMutationActor() ?? null,
  });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "validate") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = validateInvoice(payload);
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
}
else if (cmd === "invoice" && sub === "issue") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const root = companyRoot();
  const db = openDb(companyPaths(root).db); migrate(db);
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = issueInvoice(db, root, payload);
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "render") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const documentId = resolveInvoiceDocumentId(db);
  if (!documentId) {
    console.error("Missing required --document-id <n> or --invoice-number <no>");
    process.exit(2);
  }
  const result = renderIssuedInvoicePdf(db, companyRoot(), { invoiceDocumentId: documentId });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "credit-note") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const root = companyRoot();
  const db = openDb(companyPaths(root).db); migrate(db);
  const payload = withResolvedInvoicePayload(db, JSON.parse(readFileSync(input, "utf8")), "originalInvoiceDocumentId", "originalInvoiceNumber");
  const result = issueCreditNote(db, root, payload);
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "post") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const documentId = resolveInvoiceDocumentId(db);
  if (!documentId) {
    console.error("Missing required --document-id <n> or --invoice-number <no>");
    process.exit(2);
  }
  const result = postIssuedInvoiceToLedger(db, { invoiceDocumentId: documentId });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "settle-bank") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = withResolvedInvoicePayload(db, JSON.parse(readFileSync(input, "utf8")), "invoiceDocumentId", "invoiceNumber");
  const result = settleInvoiceFromBank(db, payload);
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "settle-claim-bank") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = withResolvedInvoicePayload(db, JSON.parse(readFileSync(input, "utf8")), "invoiceDocumentId", "invoiceNumber");
  const result = settleInvoiceClaimsFromBank(db, payload);
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "write-off-bad-debt") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = withResolvedInvoicePayload(db, JSON.parse(readFileSync(input, "utf8")), "invoiceDocumentId", "invoiceNumber");
  const result = writeOffInvoiceBadDebt(db, payload);
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "apply-payment") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = withResolvedInvoicePayload(db, JSON.parse(readFileSync(input, "utf8")), "invoiceDocumentId", "invoiceNumber");
  const result = applyInvoicePayment(db, payload);
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "refund-bank") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = withResolvedInvoicePayload(db, JSON.parse(readFileSync(input, "utf8")), "invoiceDocumentId", "invoiceNumber");
  const result = refundInvoiceToBank(db, payload);
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "remind") {
  const reminderDate = arg("--date");
  const feeArg = arg("--fee");
  const feeAmount = feeArg === undefined ? undefined : Number(feeArg);
  const note = arg("--note");
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const documentId = resolveInvoiceDocumentId(db);
  if (!documentId || !reminderDate || (feeArg !== undefined && Number.isNaN(feeAmount))) {
    console.error("Missing required --document-id <n> or --invoice-number <no> or --date <YYYY-MM-DD>; optional --fee <n> must be numeric when present");
    process.exit(2);
  }
  const result = registerInvoiceReminder(db, { invoiceDocumentId: documentId, reminderDate, feeAmount, note: note ?? undefined });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "post-reminder") {
  const reminderIdArg = arg("--reminder-id");
  const reminderId = reminderIdArg === undefined ? undefined : Number(reminderIdArg);
  const transactionDate = arg("--date");
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const documentId = resolveInvoiceDocumentId(db);
  if (!documentId || (reminderIdArg !== undefined && (!Number.isInteger(reminderId) || reminderId <= 0))) {
    console.error("Missing required --document-id <n> or --invoice-number <no>; optional --reminder-id <n> must be a positive integer when present");
    process.exit(2);
  }
  const result = postInvoiceReminderToLedger(db, { invoiceDocumentId: documentId, reminderId, transactionDate: transactionDate ?? undefined });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "status") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const documentId = resolveInvoiceDocumentId(db);
  if (!documentId) {
    console.error("Missing required --document-id <n> or --invoice-number <no>");
    process.exit(2);
  }
  const result = getInvoiceStatus(db, documentId, arg("--as-of"));
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "list") {
  const minAmount = parseOptionalNumber("--min-amount");
  const maxAmount = parseOptionalNumber("--max-amount");
  if (!minAmount.ok) fatal(minAmount.error);
  if (!maxAmount.ok) fatal(maxAmount.error);
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = buildInvoiceList(db, {
    status: (arg("--status") as any) ?? "all",
    from: arg("--from") ?? undefined,
    to: arg("--to") ?? undefined,
    customerCvr: arg("--customer-cvr") ?? undefined,
    customer: arg("--customer") ?? undefined,
    invoiceNumber: arg("--invoice-number") ?? undefined,
    minAmount: minAmount.value,
    maxAmount: maxAmount.value,
    asOfDate: arg("--as-of") ?? undefined,
  });
  if (outputFormat === "json") emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  else renderInvoiceRowsHuman(`Invoices (${result.count})`, result.rows, "No invoices for current filter.");
  db.close();
}
else if (cmd === "invoice" && sub === "find") {
  const amount = parseOptionalNumber("--amount");
  if (!amount.ok) fatal(amount.error);
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = findInvoices(db, {
    query: parsedArgs.positionals.slice(2).join(" ") || undefined,
    customer: arg("--customer") ?? undefined,
    invoiceNumber: arg("--invoice-number") ?? undefined,
    minAmount: amount.value,
    maxAmount: amount.value,
    asOfDate: arg("--as-of") ?? undefined,
  });
  if (outputFormat === "json") emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  else renderInvoiceRowsHuman(`Invoice matches (${result.count})`, result.rows, "No invoices matched the query.");
  db.close();
}
else if (cmd === "invoice" && sub === "overdue") {
  const minDays = parseOptionalNumber("--min-days");
  if (!minDays.ok) fatal(minDays.error);
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = buildOverdueInvoiceList(db, {
    asOfDate: arg("--as-of") ?? undefined,
    minDays: minDays.value,
  });
  if (outputFormat === "json") emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  else renderInvoiceRowsHuman(`Overdue invoices as of ${result.asOfDate ?? "today"} (${result.count})`, result.rows, "No overdue invoices for current filter.");
  db.close();
}
else if (cmd === "invoice" && sub === "interest") {
  const asOfDate = arg("--as-of");
  const referenceRatePercent = Number(arg("--reference-rate"));
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const documentId = resolveInvoiceDocumentId(db);
  if (!documentId || !asOfDate || Number.isNaN(referenceRatePercent)) {
    console.error("Missing required --document-id <n> or --invoice-number <no>, --as-of <YYYY-MM-DD>, or --reference-rate <pct>");
    process.exit(2);
  }
  const result = calculateInvoiceLateInterest(db, { invoiceDocumentId: documentId, asOfDate, referenceRatePercent });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "claim-interest") {
  const asOfDate = arg("--as-of");
  const rateArg = arg("--reference-rate");
  const note = arg("--note");
  const referenceRatePercent = rateArg === undefined ? NaN : Number(rateArg);
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const documentId = resolveInvoiceDocumentId(db);
  if (!documentId || !asOfDate || Number.isNaN(referenceRatePercent)) {
    console.error("Missing required --document-id <n> or --invoice-number <no>, --as-of <YYYY-MM-DD>, or --reference-rate <pct>");
    process.exit(2);
  }
  const result = registerInvoiceLateInterest(db, { invoiceDocumentId: documentId, asOfDate, referenceRatePercent, note: note ?? undefined });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "post-interest") {
  const claimIdArg = arg("--claim-id");
  const claimId = claimIdArg === undefined ? undefined : Number(claimIdArg);
  const transactionDate = arg("--date");
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const documentId = resolveInvoiceDocumentId(db);
  if (!documentId || (claimIdArg !== undefined && (!Number.isInteger(claimId) || claimId <= 0))) {
    console.error("Missing required --document-id <n> or --invoice-number <no>; optional --claim-id <n> must be a positive integer when present");
    process.exit(2);
  }
  const result = postInvoiceLateInterestToLedger(db, { invoiceDocumentId: documentId, claimId, transactionDate: transactionDate ?? undefined });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "compensation") {
  const asOfDate = arg("--as-of");
  const amountArg = arg("--amount-dkk");
  const compensationAmountDkk = amountArg === undefined ? undefined : Number(amountArg);
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const documentId = resolveInvoiceDocumentId(db);
  if (!documentId || !asOfDate || (amountArg !== undefined && Number.isNaN(compensationAmountDkk))) {
    console.error("Missing required --document-id <n> or --invoice-number <no> or --as-of <YYYY-MM-DD>; optional --amount-dkk <n> must be numeric when present");
    process.exit(2);
  }
  const result = calculateInvoiceLateCompensation(db, { invoiceDocumentId: documentId, asOfDate, compensationAmountDkk });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "claim-compensation") {
  const asOfDate = arg("--as-of");
  const amountArg = arg("--amount-dkk");
  const note = arg("--note");
  const compensationAmountDkk = amountArg === undefined ? undefined : Number(amountArg);
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const documentId = resolveInvoiceDocumentId(db);
  if (!documentId || !asOfDate || (amountArg !== undefined && Number.isNaN(compensationAmountDkk))) {
    console.error("Missing required --document-id <n> or --invoice-number <no> or --as-of <YYYY-MM-DD>; optional --amount-dkk must be numeric when present");
    process.exit(2);
  }
  const result = registerInvoiceLateCompensation(db, { invoiceDocumentId: documentId, asOfDate, compensationAmountDkk, note: note ?? undefined });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "invoice" && sub === "post-compensation") {
  const transactionDate = arg("--date");
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const documentId = resolveInvoiceDocumentId(db);
  if (!documentId) {
    console.error("Missing required --document-id <n> or --invoice-number <no>");
    process.exit(2);
  }
  const result = postInvoiceLateCompensationToLedger(db, { invoiceDocumentId: documentId, transactionDate: transactionDate ?? undefined });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "documents" && sub === "ingest") {
  const file = arg("--file");
  const metadataFile = arg("--metadata");
  if (!file || !metadataFile) {
    console.error("Missing required --file <path> or --metadata <file.json>");
    process.exit(2);
  }
  const root = companyRoot();
  const db = openDb(companyPaths(root).db); migrate(db);
  const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
  const result = ingestDocument(db, root, file, metadata, { forceDuplicateLogicalIdentity: hasFlag("--force") });
  if (!result.ok) {
    recordException(db, {
      type: "DOCUMENT_INGEST_BLOCKED",
      severity: "medium",
      message: `Document ingest blocked for ${file}`,
      requiredAction: "Fix document metadata or duplicate handling, then retry ingest.",
      sourceEvidence: {
        file,
        metadataFile,
        errors: result.errors ?? [],
      },
      postingPreview: {
        retryCommand: "documents ingest --company <path> --file <file> --metadata <file.json>",
      },
    });
  }
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "documents" && sub === "list") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const rows = db.query("SELECT id, document_no, source, original_filename, invoice_date, amount_inc_vat, currency, status, stored_path FROM documents ORDER BY id DESC").all();
  console.table(rows);
  db.close();
}
else if (cmd === "bank" && sub === "import") {
  const file = arg("--file");
  if (!file) {
    console.error("Missing required --file <transactions.csv>");
    process.exit(2);
  }
  const root = companyRoot();
  const db = openDb(companyPaths(root).db); migrate(db);
  const result = importBankCsv(db, root, file);
  const sync = result.ok ? syncUnmatchedBankTransactionExceptions(db) : { ok: true, created: 0, errors: [] };
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), {
    ...(result as Record<string, unknown>),
    exceptionsCreated: sync.created,
  }, outputFormat);
  db.close();
}
else if (cmd === "bank" && sub === "list") {
  const amountArg = arg("--amount");
  const amount = amountArg === undefined ? undefined : Number(amountArg);
  if (amountArg !== undefined && Number.isNaN(amount)) {
    console.error("--amount must be numeric when present");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = listBankTransactions(db, {
    status: arg("--status") as any,
    from: arg("--from") ?? undefined,
    to: arg("--to") ?? undefined,
    textMatch: arg("--text-match") ?? undefined,
    amount,
  });
  if (outputFormat === "json") emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  else if (result.ok) console.table(result.rows);
  else console.error(result.errors.join("\n"));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "bank" && sub === "suggest-matches") {
  const bankTransactionId = parseOptionalNumber("--bank-transaction-id");
  const max = parseOptionalNumber("--max");
  if (!bankTransactionId.ok) fatal(bankTransactionId.error);
  if (!max.ok) fatal(max.error);
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = suggestBankMatches(db, {
    bankTransactionId: bankTransactionId.value === undefined ? undefined : Number(bankTransactionId.value),
    max: max.value === undefined ? undefined : Number(max.value),
  });
  if (outputFormat === "json") emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  else if (result.ok) renderBankSuggestionsHuman(result.rows);
  else console.error(result.errors.join("\n"));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "reconcile" && sub === "bank") {
  const from = arg("--from");
  const to = arg("--to");
  const amountArg = arg("--amount");
  const amount = amountArg === undefined ? undefined : Number(amountArg);
  if (!from || !to) {
    console.error("Missing required --from <YYYY-MM-DD> or --to <YYYY-MM-DD>");
    process.exit(2);
  }
  if (amountArg !== undefined && Number.isNaN(amount)) {
    console.error("--amount must be numeric when present");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = buildBankReconciliationReport(db, from, to, {
    status: arg("--status") as any,
    textMatch: arg("--text-match") ?? undefined,
    amount,
  });
  if (outputFormat === "json") emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  else if (result.ok) {
    console.log(`Matched: ${result.matchedCount} | Unmatched: ${result.unmatchedCount} | Period: ${result.periodStart}..${result.periodEnd}`);
    if (result.matched.length > 0) {
      console.log("\nMatched");
      console.table(result.matched);
    }
    if (result.unmatched.length > 0) {
      console.log("\nUnmatched");
      console.table(result.unmatched);
    }
    if (result.matched.length === 0 && result.unmatched.length === 0) console.log("No rows for current filter.");
  } else console.error(result.errors.join("\n"));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "vat" && sub === "report") {
  const from = arg("--from");
  const to = arg("--to");
  if (!from || !to) {
    console.error("Missing required --from <YYYY-MM-DD> or --to <YYYY-MM-DD>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = buildVatReport(db, from, to);
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "vat" && sub === "post-eu-service-purchase") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const invoiceNo = typeof payload.invoiceNo === "string" ? payload.invoiceNo.trim() : "";
  if (invoiceNo) {
    const row = db.query(`SELECT id FROM documents WHERE invoice_no = ? ORDER BY id DESC LIMIT 1`).get(invoiceNo) as { id: number } | null;
    if (!row) {
      console.error(`Could not resolve document for invoiceNo ${invoiceNo}`);
      process.exit(2);
    }
    payload.documentId = row.id;
  }
  const result = postEuServiceReverseChargePurchase(db, payload);
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "vat" && sub === "post-representation-purchase") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = postRepresentationPurchase(db, payload);
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "retention" && sub === "status") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = buildRetentionStatusReport(db, arg("--as-of"));
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "period" && sub === "close") {
  const from = arg("--from");
  const to = arg("--to");
  if (!from || !to) {
    console.error("Missing required --from <YYYY-MM-DD> or --to <YYYY-MM-DD>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = closeAccountingPeriod(db, {
    periodStart: from,
    periodEnd: to,
    kind: (arg("--kind") as any) ?? undefined,
    status: (arg("--status") as any) ?? undefined,
    reference: arg("--reference") ?? undefined,
  });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "expense" && sub === "book") {
  const documentId = Number(arg("--document-id"));
  const bankTransactionId = Number(arg("--bank-transaction-id"));
  const expenseAccountNo = arg("--expense-account");
  const vatTreatment = arg("--vat-treatment") as "standard" | "reverse_charge" | "representation" | "exempt" | undefined;
  if (!Number.isInteger(documentId) || documentId <= 0 || !Number.isInteger(bankTransactionId) || bankTransactionId <= 0 || !expenseAccountNo) {
    console.error("Missing required --document-id <n>, --bank-transaction-id <n>, or --expense-account <account>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = bookExpenseFromBank(db, {
    documentId,
    bankTransactionId,
    expenseAccountNo,
    vatTreatment,
    paymentAccountNo: arg("--payment-account") ?? undefined,
    transactionDate: arg("--date") ?? undefined,
    text: arg("--text") ?? undefined,
  });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "journal" && sub === "post") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = postJournalEntry(db, payload);
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "journal" && sub === "reverse") {
  const date = arg("--date");
  const reason = arg("--reason");
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const entryId = resolveJournalEntryId(db);
  if (!entryId || !date || !reason) {
    console.error("Missing required --entry-id <n> or --entry-no <no>, --date <YYYY-MM-DD>, or --reason <text>");
    process.exit(2);
  }
  const result = reverseJournalEntry(db, { entryId, transactionDate: date, reason });
  emitResult(commandSpec?.description ?? `${cmd} ${sub}`.trim(), result as Record<string, unknown>, outputFormat);
  db.close();
}
else if (cmd === "journal" && sub === "list") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const rows = db.query("SELECT id, entry_no, transaction_date, text, currency, amount_foreign, amount_dkk, fx_rate_to_dkk, document_id, source_bank_transaction_id, status, reversal_of_entry_id FROM journal_entries ORDER BY id DESC").all();
  console.table(rows);
  db.close();
}
else {
  console.error(`Unknown command: ${cmd}${sub ? " " + sub : ""}`);
  usage();
  process.exit(2);
}
