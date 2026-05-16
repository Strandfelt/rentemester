#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureCompanyDirs, companyPaths } from "./core/paths";
import { openDb, migrate } from "./core/db";
import { postJournalEntry, reverseJournalEntry, seedAccounts, verifyAuditChain } from "./core/ledger";
import { validateInvoice } from "./core/invoice";
import { ingestDocument } from "./core/documents";
import { importBankCsv } from "./core/bank";
import { buildVatReport, postEuServiceReverseChargePurchase } from "./core/vat";
import { buildBankReconciliationReport } from "./core/reconciliation";

function arg(name: string, fallback?: string) {
  const i = Bun.argv.indexOf(name);
  return i >= 0 ? Bun.argv[i + 1] : fallback;
}
function companyRoot() { return arg("--company", process.env.RENTEMESTER_COMPANY ?? "/company")!; }
function usage() {
  console.log(`Rentemester v0.0.1\n\nCommands:\n  init --company <path>\n  system healthcheck --company <path>\n  audit verify --company <path>\n  accounts list --company <path>\n  exceptions list --company <path>\n  invoice validate --input <file.json>\n  documents ingest --company <path> --file <path> --metadata <file.json>\n  documents list --company <path>\n  bank import --company <path> --file <transactions.csv>\n  bank list --company <path>\n  reconcile bank --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD>\n  vat report --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD>\n  vat post-eu-service-purchase --company <path> --input <file.json>\n  journal post --company <path> --input <file.json>\n  journal reverse --company <path> --entry-id <n> --date <YYYY-MM-DD> --reason <text>\n  journal list --company <path>`);
}

const [cmd, sub] = Bun.argv.slice(2).filter(a => !a.startsWith("--") && !Bun.argv[Bun.argv.indexOf(a)-1]?.startsWith("--"));

if (!cmd || cmd === "help" || cmd === "--help") usage();
else if (cmd === "init") {
  const root = companyRoot();
  const p = ensureCompanyDirs(root);
  const db = openDb(p.db); migrate(db); seedAccounts(db);
  db.run("INSERT OR IGNORE INTO companies (id, name) VALUES (1, 'Rentemester company')");
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
else if (cmd === "audit" && sub === "verify") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const r = verifyAuditChain(db);
  console.log(JSON.stringify(r, null, 2));
  db.close();
  if (!r.ok) process.exit(1);
}
else if (cmd === "accounts" && sub === "list") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const rows = db.query("SELECT account_no, name, type, default_vat_code FROM accounts ORDER BY account_no").all();
  console.table(rows);
  db.close();
}
else if (cmd === "exceptions" && sub === "list") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const rows = db.query("SELECT id, type, severity, status, message, required_action, created_at FROM exceptions ORDER BY id DESC").all();
  console.table(rows);
  db.close();
}
else if (cmd === "invoice" && sub === "validate") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = validateInvoice(payload);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
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
  const result = ingestDocument(db, root, file, metadata);
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
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
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "bank" && sub === "list") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const rows = db.query("SELECT id, transaction_date, booking_date, text, amount, currency, reference, import_batch_id, status FROM bank_transactions ORDER BY id DESC").all();
  console.table(rows);
  db.close();
}
else if (cmd === "reconcile" && sub === "bank") {
  const from = arg("--from");
  const to = arg("--to");
  if (!from || !to) {
    console.error("Missing required --from <YYYY-MM-DD> or --to <YYYY-MM-DD>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = buildBankReconciliationReport(db, from, to);
  console.log(JSON.stringify(result, null, 2));
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
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "vat" && sub === "post-eu-service-purchase") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = postEuServiceReverseChargePurchase(db, payload);
  console.log(JSON.stringify(result, null, 2));
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
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "journal" && sub === "reverse") {
  const entryId = Number(arg("--entry-id"));
  const date = arg("--date");
  const reason = arg("--reason");
  if (!Number.isInteger(entryId) || !date || !reason) {
    console.error("Missing required --entry-id <n>, --date <YYYY-MM-DD>, or --reason <text>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = reverseJournalEntry(db, { entryId, transactionDate: date, reason });
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "journal" && sub === "list") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const rows = db.query("SELECT id, entry_no, transaction_date, text, document_id, source_bank_transaction_id, status, reversal_of_entry_id FROM journal_entries ORDER BY id DESC").all();
  console.table(rows);
  db.close();
}
else {
  console.error(`Unknown command: ${cmd}${sub ? " " + sub : ""}`);
  usage();
  process.exit(2);
}
