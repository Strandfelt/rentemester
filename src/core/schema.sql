CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Unnamed company',
  country TEXT NOT NULL DEFAULT 'DK',
  currency TEXT NOT NULL DEFAULT 'DKK',
  cvr TEXT,
  fiscal_year_start_month INTEGER NOT NULL DEFAULT 1 CHECK(fiscal_year_start_month BETWEEN 1 AND 12),
  fiscal_year_label_strategy TEXT NOT NULL DEFAULT 'end-year' CHECK(fiscal_year_label_strategy IN ('end-year', 'start-year', 'span')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  account_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','income','expense','vat')),
  normal_balance TEXT NOT NULL CHECK(normal_balance IN ('debit','credit')),
  active INTEGER NOT NULL DEFAULT 1,
  default_vat_code TEXT,
  allow_direct_posting INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sequences (
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  value INTEGER NOT NULL CHECK(value >= 0),
  PRIMARY KEY (kind, scope)
);

CREATE TABLE IF NOT EXISTS vies_validations (
  country_code TEXT NOT NULL,
  vat_number TEXT NOT NULL,
  valid INTEGER NOT NULL,
  name TEXT,
  address TEXT,
  validated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  raw_response TEXT,
  PRIMARY KEY (country_code, vat_number)
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  vat_or_cvr TEXT,
  email TEXT,
  ean_number TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK(payment_terms_days > 0),
  default_currency TEXT NOT NULL DEFAULT 'DKK',
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(vat_or_cvr, name)
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  vat_or_cvr TEXT,
  default_expense_account TEXT,
  default_vat_treatment TEXT,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(vat_or_cvr, name)
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  document_no TEXT UNIQUE,
  source TEXT NOT NULL,
  original_filename TEXT,
  stored_path TEXT,
  mime_type TEXT,
  sha256_hash TEXT NOT NULL UNIQUE,
  upload_datetime TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  supplier_name TEXT,
  invoice_no TEXT,
  invoice_date TEXT,
  amount_inc_vat NUMERIC,
  currency TEXT NOT NULL DEFAULT 'DKK',
  status TEXT NOT NULL DEFAULT 'ingested',
  document_type TEXT NOT NULL DEFAULT 'purchase_sale',
  delivery_description TEXT,
  sender_name TEXT,
  sender_address TEXT,
  sender_vat_cvr TEXT,
  recipient_name TEXT,
  recipient_address TEXT,
  recipient_vat_cvr TEXT,
  vat_amount NUMERIC,
  payment_details TEXT,
  exemption_code TEXT,
  payload_json TEXT,
  retain_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_purchase_sale_logical_identity
ON documents(sender_vat_cvr, invoice_no, invoice_date)
WHERE document_type = 'purchase_sale';

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_issued_invoice_no_unique
ON documents(invoice_no)
WHERE document_type = 'issued_invoice';

CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY,
  transaction_date TEXT NOT NULL,
  booking_date TEXT,
  text TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'DKK',
  reference TEXT,
  amount_dkk NUMERIC,
  fx_rate_to_dkk NUMERIC,
  source_file_hash TEXT,
  import_batch_id TEXT,
  transaction_hash TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'imported',
  retain_until TEXT
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY,
  entry_no TEXT NOT NULL UNIQUE,
  transaction_date TEXT NOT NULL,
  registration_datetime TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  text TEXT NOT NULL,
  source_bank_transaction_id INTEGER,
  document_id INTEGER,
  currency TEXT NOT NULL DEFAULT 'DKK',
  amount_foreign NUMERIC,
  amount_dkk NUMERIC,
  fx_rate_to_dkk NUMERIC,
  rule_version TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_by_program TEXT NOT NULL DEFAULT 'rentemester',
  status TEXT NOT NULL CHECK(status IN ('posted','reversed')) DEFAULT 'posted',
  reversal_of_entry_id INTEGER,
  previous_hash TEXT,
  entry_hash TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 1,
  retain_until TEXT,
  FOREIGN KEY(source_bank_transaction_id) REFERENCES bank_transactions(id),
  FOREIGN KEY(document_id) REFERENCES documents(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_bank_source_posted
ON journal_entries(source_bank_transaction_id)
WHERE source_bank_transaction_id IS NOT NULL AND status = 'posted';

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY,
  journal_entry_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  debit_amount NUMERIC NOT NULL DEFAULT 0 CHECK(debit_amount >= 0),
  credit_amount NUMERIC NOT NULL DEFAULT 0 CHECK(credit_amount >= 0),
  vat_code TEXT,
  currency TEXT NOT NULL DEFAULT 'DKK',
  text TEXT,
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id),
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  CHECK(NOT (debit_amount > 0 AND credit_amount > 0))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  message TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounting_periods (
  id INTEGER PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('vat_quarter','fiscal_year','custom')),
  status TEXT NOT NULL CHECK(status IN ('open','closed','reported')) DEFAULT 'open',
  closed_at TEXT,
  closed_by TEXT,
  reported_at TEXT,
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(period_start, period_end, kind)
);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  bank_transaction_id INTEGER,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  payment_date TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount > 0),
  currency TEXT NOT NULL DEFAULT 'DKK',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
  FOREIGN KEY(bank_transaction_id) REFERENCES bank_transactions(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS invoice_refunds (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  bank_transaction_id INTEGER,
  refund_date TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount > 0),
  currency TEXT NOT NULL DEFAULT 'DKK',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
  FOREIGN KEY(bank_transaction_id) REFERENCES bank_transactions(id)
);

CREATE TABLE IF NOT EXISTS invoice_reminders (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  reminder_date TEXT NOT NULL,
  fee_amount NUMERIC NOT NULL CHECK(fee_amount > 0),
  currency TEXT NOT NULL DEFAULT 'DKK',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS invoice_compensation_claims (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL UNIQUE,
  claim_date TEXT NOT NULL,
  amount_dkk NUMERIC NOT NULL CHECK(amount_dkk > 0),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS invoice_interest_claims (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  claim_date TEXT NOT NULL,
  reference_rate_percent NUMERIC NOT NULL,
  annual_interest_rate_percent NUMERIC NOT NULL,
  overdue_days INTEGER NOT NULL,
  principal_open_balance NUMERIC NOT NULL,
  amount_dkk NUMERIC NOT NULL CHECK(amount_dkk > 0),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(invoice_document_id, claim_date, reference_rate_percent),
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS invoice_compensation_postings (
  id INTEGER PRIMARY KEY,
  compensation_claim_id INTEGER NOT NULL UNIQUE,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(compensation_claim_id) REFERENCES invoice_compensation_claims(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS invoice_reminder_postings (
  id INTEGER PRIMARY KEY,
  reminder_id INTEGER NOT NULL UNIQUE,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(reminder_id) REFERENCES invoice_reminders(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS invoice_interest_postings (
  id INTEGER PRIMARY KEY,
  interest_claim_id INTEGER NOT NULL UNIQUE,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(interest_claim_id) REFERENCES invoice_interest_claims(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS invoice_claim_payments (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  bank_transaction_id INTEGER,
  payment_date TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount > 0),
  currency TEXT NOT NULL DEFAULT 'DKK',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
  FOREIGN KEY(bank_transaction_id) REFERENCES bank_transactions(id)
);

CREATE TABLE IF NOT EXISTS invoice_bad_debt_writeoffs (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  writeoff_date TEXT NOT NULL,
  gross_amount NUMERIC NOT NULL CHECK(gross_amount > 0),
  net_amount NUMERIC NOT NULL CHECK(net_amount >= 0),
  vat_amount NUMERIC NOT NULL CHECK(vat_amount >= 0),
  note TEXT,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS exceptions (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  related_bank_transaction_id INTEGER,
  related_document_id INTEGER,
  message TEXT NOT NULL,
  required_action TEXT,
  source_evidence TEXT,
  posting_preview TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT
);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS accounting_periods_guard_update
BEFORE UPDATE ON accounting_periods
WHEN OLD.period_start != NEW.period_start
   OR OLD.period_end != NEW.period_end
   OR OLD.kind != NEW.kind
   OR OLD.created_at != NEW.created_at
   OR OLD.status = 'reported'
   OR (OLD.status = 'closed' AND NEW.status = 'open')
   OR (OLD.status = 'open' AND NEW.status = 'reported')
   OR NEW.status NOT IN ('open', 'closed', 'reported')
BEGIN
  SELECT RAISE(ABORT, 'accounting periods may only progress open -> closed -> reported; period bounds are immutable');
END;

CREATE TRIGGER IF NOT EXISTS accounting_periods_no_delete
BEFORE DELETE ON accounting_periods
BEGIN
  SELECT RAISE(ABORT, 'accounting periods are append-only');
END;

CREATE TRIGGER IF NOT EXISTS sequences_monotone_update
BEFORE UPDATE ON sequences
WHEN OLD.kind != NEW.kind
   OR OLD.scope != NEW.scope
   OR NEW.value < OLD.value
BEGIN
  SELECT RAISE(ABORT, 'sequences are immutable identifiers and monotonically increasing');
END;

CREATE TRIGGER IF NOT EXISTS sequences_no_delete
BEFORE DELETE ON sequences
BEGIN
  SELECT RAISE(ABORT, 'sequences are append-only');
END;

CREATE TRIGGER IF NOT EXISTS exceptions_guard_update
BEFORE UPDATE ON exceptions
WHEN OLD.type != NEW.type
   OR OLD.severity != NEW.severity
   OR OLD.related_bank_transaction_id IS NOT NEW.related_bank_transaction_id
   OR OLD.related_document_id IS NOT NEW.related_document_id
   OR OLD.created_at != NEW.created_at
   OR (OLD.status = 'resolved' AND NEW.status = 'open')
BEGIN
  SELECT RAISE(ABORT, 'exceptions may only progress from open to resolved; identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS exceptions_no_delete
BEFORE DELETE ON exceptions
BEGIN
  SELECT RAISE(ABORT, 'exceptions are append-only; resolve them instead');
END;

CREATE TRIGGER IF NOT EXISTS companies_fiscal_lock
BEFORE UPDATE ON companies
WHEN (OLD.fiscal_year_start_month != NEW.fiscal_year_start_month
   OR OLD.fiscal_year_label_strategy != NEW.fiscal_year_label_strategy)
 AND EXISTS(SELECT 1 FROM journal_entries LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'fiscal year configuration is locked after the first journal entry');
END;

CREATE TRIGGER IF NOT EXISTS customers_no_update
BEFORE UPDATE ON customers
BEGIN
  SELECT RAISE(ABORT, 'customers are append-only; create a new customer record instead');
END;

CREATE TRIGGER IF NOT EXISTS customers_no_delete
BEFORE DELETE ON customers
BEGIN
  SELECT RAISE(ABORT, 'customers are append-only; archive or supersede them instead');
END;

CREATE TRIGGER IF NOT EXISTS vendors_no_update
BEFORE UPDATE ON vendors
BEGIN
  SELECT RAISE(ABORT, 'vendors are append-only; create a new vendor record instead');
END;

CREATE TRIGGER IF NOT EXISTS vendors_no_delete
BEFORE DELETE ON vendors
BEGIN
  SELECT RAISE(ABORT, 'vendors are append-only; archive or supersede them instead');
END;

CREATE TRIGGER IF NOT EXISTS journal_entries_no_update
BEFORE UPDATE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'journal_entries are append-only; create reversal instead');
END;

CREATE TRIGGER IF NOT EXISTS journal_entries_no_delete
BEFORE DELETE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'journal_entries are append-only; create reversal instead');
END;

CREATE TRIGGER IF NOT EXISTS journal_lines_no_update
BEFORE UPDATE ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'journal_lines are append-only; reverse the parent entry instead');
END;

CREATE TRIGGER IF NOT EXISTS journal_lines_no_delete
BEFORE DELETE ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'journal_lines are append-only; reverse the parent entry instead');
END;

CREATE TRIGGER IF NOT EXISTS documents_no_update_issued_invoice
BEFORE UPDATE ON documents
WHEN OLD.document_type IN ('issued_invoice','credit_note')
BEGIN
  SELECT RAISE(ABORT, 'issued invoice documents are append-only; create credit note instead');
END;

CREATE TRIGGER IF NOT EXISTS documents_no_delete_issued_invoice
BEFORE DELETE ON documents
WHEN OLD.document_type IN ('issued_invoice','credit_note')
BEGIN
  SELECT RAISE(ABORT, 'issued invoice documents are append-only; create credit note instead');
END;

CREATE TRIGGER IF NOT EXISTS documents_no_update_when_linked
BEFORE UPDATE ON documents
WHEN OLD.document_type IN ('purchase_sale','cash_register_receipt')
  AND EXISTS(SELECT 1 FROM journal_entries WHERE document_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'document is linked to a journal entry and cannot be modified; reverse the entry first');
END;

CREATE TRIGGER IF NOT EXISTS documents_no_delete_when_linked
BEFORE DELETE ON documents
WHEN OLD.document_type IN ('purchase_sale','cash_register_receipt')
  AND EXISTS(SELECT 1 FROM journal_entries WHERE document_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'document is linked to a journal entry and cannot be deleted; reverse the entry first');
END;

CREATE TRIGGER IF NOT EXISTS bank_transactions_no_update_when_referenced
BEFORE UPDATE ON bank_transactions
WHEN EXISTS(SELECT 1 FROM journal_entries WHERE source_bank_transaction_id = OLD.id)
   OR EXISTS(SELECT 1 FROM invoice_payments WHERE bank_transaction_id = OLD.id)
   OR EXISTS(SELECT 1 FROM invoice_refunds WHERE bank_transaction_id = OLD.id)
   OR EXISTS(SELECT 1 FROM invoice_claim_payments WHERE bank_transaction_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'bank transaction is referenced by ledger or payment records and cannot be modified');
END;

CREATE TRIGGER IF NOT EXISTS bank_transactions_no_delete
BEFORE DELETE ON bank_transactions
BEGIN
  SELECT RAISE(ABORT, 'bank transactions are append-only; correct via journal reversal or new import');
END;

CREATE TRIGGER IF NOT EXISTS invoice_payments_require_journal
BEFORE INSERT ON invoice_payments
WHEN NEW.journal_entry_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'invoice payments must reference a journal entry');
END;

CREATE TRIGGER IF NOT EXISTS invoice_payments_no_update
BEFORE UPDATE ON invoice_payments
BEGIN
  SELECT RAISE(ABORT, 'invoice payments are append-only; add a correcting payment application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_payments_no_delete
BEFORE DELETE ON invoice_payments
BEGIN
  SELECT RAISE(ABORT, 'invoice payments are append-only; add a correcting payment application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_refunds_no_update
BEFORE UPDATE ON invoice_refunds
BEGIN
  SELECT RAISE(ABORT, 'invoice refunds are append-only; add a correcting refund application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_refunds_no_delete
BEFORE DELETE ON invoice_refunds
BEGIN
  SELECT RAISE(ABORT, 'invoice refunds are append-only; add a correcting refund application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_reminders_no_update
BEFORE UPDATE ON invoice_reminders
BEGIN
  SELECT RAISE(ABORT, 'invoice reminders are append-only; add a later reminder or corrective note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_reminders_no_delete
BEFORE DELETE ON invoice_reminders
BEGIN
  SELECT RAISE(ABORT, 'invoice reminders are append-only; add a corrective note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_compensation_claims_no_update
BEFORE UPDATE ON invoice_compensation_claims
BEGIN
  SELECT RAISE(ABORT, 'invoice compensation claims are append-only; add a correcting note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_compensation_claims_no_delete
BEFORE DELETE ON invoice_compensation_claims
BEGIN
  SELECT RAISE(ABORT, 'invoice compensation claims are append-only; add a corrective note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_claims_no_update
BEFORE UPDATE ON invoice_interest_claims
BEGIN
  SELECT RAISE(ABORT, 'invoice interest claims are append-only; add a correcting note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_claims_no_delete
BEFORE DELETE ON invoice_interest_claims
BEGIN
  SELECT RAISE(ABORT, 'invoice interest claims are append-only; add a corrective note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_compensation_postings_no_update
BEFORE UPDATE ON invoice_compensation_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice compensation postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_compensation_postings_no_delete
BEFORE DELETE ON invoice_compensation_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice compensation postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_reminder_postings_no_update
BEFORE UPDATE ON invoice_reminder_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice reminder postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_reminder_postings_no_delete
BEFORE DELETE ON invoice_reminder_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice reminder postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_postings_no_update
BEFORE UPDATE ON invoice_interest_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice interest postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_postings_no_delete
BEFORE DELETE ON invoice_interest_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice interest postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_claim_payments_no_update
BEFORE UPDATE ON invoice_claim_payments
BEGIN
  SELECT RAISE(ABORT, 'invoice claim payments are append-only; add a correcting claim payment application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_claim_payments_no_delete
BEFORE DELETE ON invoice_claim_payments
BEGIN
  SELECT RAISE(ABORT, 'invoice claim payments are append-only; add a correcting claim payment application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_bad_debt_writeoffs_no_update
BEFORE UPDATE ON invoice_bad_debt_writeoffs
BEGIN
  SELECT RAISE(ABORT, 'invoice bad-debt writeoffs are append-only; add a correcting journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_bad_debt_writeoffs_no_delete
BEFORE DELETE ON invoice_bad_debt_writeoffs
BEGIN
  SELECT RAISE(ABORT, 'invoice bad-debt writeoffs are append-only; add a correcting journal entry instead');
END;

-- ===== RECURRING INVOICES (#118) =====
-- Recurring-invoice templates and their explicit, deterministic generations.
-- A template captures the repeating invoice spec (interval, customer, lines,
-- VAT, delivery-period mode). Generation is an explicit step keyed by an
-- integer period_index counted from first_issue_date — no background
-- scheduling. UNIQUE(template_id, period_index) prevents duplicate generation
-- for the same template/period. Reminders/settlement live on the generated
-- documents row, never on the template.

CREATE TABLE IF NOT EXISTS recurring_invoice_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  interval TEXT NOT NULL CHECK(interval IN ('monthly', 'quarterly', 'yearly')),
  first_issue_date TEXT NOT NULL,
  next_issue_date TEXT NOT NULL,
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK(payment_terms_days BETWEEN 0 AND 365),
  delivery_period_mode TEXT NOT NULL DEFAULT 'issue_month'
    CHECK(delivery_period_mode IN ('issue_month', 'interval_window', 'none')),
  payload_json TEXT NOT NULL,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recurring_invoice_generations (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL,
  period_index INTEGER NOT NULL CHECK(period_index >= 0),
  document_id INTEGER NOT NULL,
  invoice_number TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  delivery_period_start TEXT,
  delivery_period_end TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(template_id) REFERENCES recurring_invoice_templates(id),
  FOREIGN KEY(document_id) REFERENCES documents(id),
  UNIQUE(template_id, period_index)
);

CREATE INDEX IF NOT EXISTS idx_recurring_invoice_generations_template
  ON recurring_invoice_generations(template_id, period_index);

-- Template identity and the embedded payload are immutable; only the
-- next_issue_date marker may advance and active may be retired (1 -> 0).
CREATE TRIGGER IF NOT EXISTS recurring_invoice_templates_guard_update
BEFORE UPDATE ON recurring_invoice_templates
WHEN OLD.name != NEW.name
   OR OLD.interval != NEW.interval
   OR OLD.first_issue_date != NEW.first_issue_date
   OR OLD.payment_terms_days != NEW.payment_terms_days
   OR OLD.delivery_period_mode != NEW.delivery_period_mode
   OR OLD.payload_json != NEW.payload_json
   OR OLD.created_at != NEW.created_at
   OR NEW.next_issue_date < OLD.next_issue_date
   OR (OLD.active = 0 AND NEW.active = 1)
BEGIN
  SELECT RAISE(ABORT, 'recurring invoice templates are append-only; only next_issue_date may advance and active may be retired');
END;

CREATE TRIGGER IF NOT EXISTS recurring_invoice_templates_no_delete
BEFORE DELETE ON recurring_invoice_templates
BEGIN
  SELECT RAISE(ABORT, 'recurring invoice templates are append-only; retire them with active = 0 instead');
END;

CREATE TRIGGER IF NOT EXISTS recurring_invoice_generations_no_update
BEFORE UPDATE ON recurring_invoice_generations
BEGIN
  SELECT RAISE(ABORT, 'recurring invoice generations are append-only audit links; issue a credit note on the generated invoice instead');
END;

CREATE TRIGGER IF NOT EXISTS recurring_invoice_generations_no_delete
BEFORE DELETE ON recurring_invoice_generations
BEGIN
  SELECT RAISE(ABORT, 'recurring invoice generations are append-only audit links; issue a credit note on the generated invoice instead');
END;
-- ===== END RECURRING INVOICES (#118) =====
-- ===== MAIL INTAKE (#122) =====
-- Append-only dedup ledger for the first deterministic bilagsmail intake
-- slice. One row per (message-id, attachment hash) pair that was ingested,
-- so rerunning the same maildrop never creates duplicate documents.
CREATE TABLE IF NOT EXISTS mail_intake_messages (
  id INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL,
  attachment_sha256 TEXT NOT NULL,
  attachment_filename TEXT,
  document_id INTEGER,
  sender TEXT,
  subject TEXT,
  mail_date TEXT,
  ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (message_id, attachment_sha256)
);

CREATE INDEX IF NOT EXISTS idx_mail_intake_messages_message_id
ON mail_intake_messages(message_id);

CREATE TRIGGER IF NOT EXISTS mail_intake_messages_no_update
BEFORE UPDATE ON mail_intake_messages
BEGIN
  SELECT RAISE(ABORT, 'mail intake dedup rows are append-only; re-ingest creates a new row instead');
END;

CREATE TRIGGER IF NOT EXISTS mail_intake_messages_no_delete
BEFORE DELETE ON mail_intake_messages
BEGIN
  SELECT RAISE(ABORT, 'mail intake dedup rows are append-only and cannot be deleted');
END;
-- ===== MILEAGE LOG (#123) =====
-- Standalone kørselsregnskab register. Mileage entries are documentation/audit
-- data only; nothing here is posted to the journal/ledger. The per-kilometre
-- rate is user-supplied and source-backed (rate_basis), never a hardcoded tax
-- rate. Entries are append-only audit data.
CREATE TABLE IF NOT EXISTS mileage_entries (
  id INTEGER PRIMARY KEY,
  entry_no TEXT NOT NULL UNIQUE,
  trip_date TEXT NOT NULL,
  purpose TEXT NOT NULL,
  from_location TEXT NOT NULL,
  to_location TEXT NOT NULL,
  kilometers NUMERIC NOT NULL CHECK(kilometers > 0),
  vehicle TEXT NOT NULL,
  driver TEXT NOT NULL,
  rate_per_km NUMERIC NOT NULL CHECK(rate_per_km > 0),
  amount_basis NUMERIC NOT NULL CHECK(amount_basis >= 0),
  rate_basis TEXT NOT NULL,
  rate_source TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mileage_entries_trip_date
ON mileage_entries(trip_date);

CREATE TRIGGER IF NOT EXISTS mileage_entries_no_update
BEFORE UPDATE ON mileage_entries
BEGIN
  SELECT RAISE(ABORT, 'mileage_entries are append-only audit data; record a correcting entry instead');
END;

CREATE TRIGGER IF NOT EXISTS mileage_entries_no_delete
BEFORE DELETE ON mileage_entries
BEGIN
  SELECT RAISE(ABORT, 'mileage_entries are append-only audit data; record a correcting entry instead');
END;
-- ===== FIXED ASSETS (#124, #125) =====
-- Append-only fixed-asset register plus its depreciation entries (#124) and
-- immediate small-asset write-offs / straksafskrivning (#125). Money is stored
-- in DKK with 2 decimals; the workflow assists bookkeeping while the
-- user/advisor remains responsible for the tax treatment.

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  acquisition_date TEXT NOT NULL,
  cost NUMERIC NOT NULL CHECK(cost > 0),
  depreciation_method TEXT NOT NULL DEFAULT 'linear' CHECK(depreciation_method IN ('linear')),
  useful_life_months INTEGER NOT NULL CHECK(useful_life_months > 0),
  asset_account_no TEXT NOT NULL,
  depreciation_expense_account_no TEXT NOT NULL,
  accumulated_depreciation_account_no TEXT NOT NULL,
  purchase_document_id INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(purchase_document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS asset_depreciation_entries (
  id INTEGER PRIMARY KEY,
  asset_id INTEGER NOT NULL,
  period_index INTEGER NOT NULL CHECK(period_index > 0),
  transaction_date TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount > 0),
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(asset_id, period_index),
  FOREIGN KEY(asset_id) REFERENCES assets(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS asset_writeoffs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  acquisition_date TEXT NOT NULL,
  writeoff_date TEXT NOT NULL,
  cost NUMERIC NOT NULL CHECK(cost > 0),
  purchase_document_id INTEGER NOT NULL UNIQUE,
  expense_account_no TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0,1)),
  threshold_dkk NUMERIC NOT NULL,
  threshold_rule_source TEXT NOT NULL,
  note TEXT,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(purchase_document_id) REFERENCES documents(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_asset_depreciation_entries_asset ON asset_depreciation_entries(asset_id);
CREATE INDEX IF NOT EXISTS idx_assets_purchase_document ON assets(purchase_document_id);

CREATE TRIGGER IF NOT EXISTS assets_no_update
BEFORE UPDATE ON assets
BEGIN
  SELECT RAISE(ABORT, 'assets are append-only; register a correcting asset record instead');
END;

CREATE TRIGGER IF NOT EXISTS assets_no_delete
BEFORE DELETE ON assets
BEGIN
  SELECT RAISE(ABORT, 'assets are append-only; register a correcting asset record instead');
END;

CREATE TRIGGER IF NOT EXISTS asset_depreciation_entries_no_update
BEFORE UPDATE ON asset_depreciation_entries
BEGIN
  SELECT RAISE(ABORT, 'asset depreciation entries are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS asset_depreciation_entries_no_delete
BEFORE DELETE ON asset_depreciation_entries
BEGIN
  SELECT RAISE(ABORT, 'asset depreciation entries are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS asset_writeoffs_no_update
BEFORE UPDATE ON asset_writeoffs
BEGIN
  SELECT RAISE(ABORT, 'asset writeoffs are append-only; add a correcting journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS asset_writeoffs_no_delete
BEFORE DELETE ON asset_writeoffs
BEGIN
  SELECT RAISE(ABORT, 'asset writeoffs are append-only; add a correcting journal entry instead');
END;
-- ===== END FIXED ASSETS (#124, #125) =====
-- ===== PEPPOL SUBMISSION (#128) =====
-- Records a deterministic PEPPOL submission attempt built on top of an
-- existing OIOUBL handoff artifact. Submission records are audit data:
-- append-only, never updated or deleted. The idempotency key protects
-- against duplicate submissions. Access-point credentials are NEVER
-- stored here — only the non-secret access-point id used to derive the
-- submission envelope. The original invoice payload is not mutated.
CREATE TABLE IF NOT EXISTS peppol_submissions (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  invoice_no TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  submission_reference TEXT NOT NULL UNIQUE,
  access_point_id TEXT NOT NULL,
  receiver_endpoint_id TEXT NOT NULL,
  oioubl_sha256 TEXT NOT NULL,
  envelope_sha256 TEXT NOT NULL,
  envelope_xml TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','acknowledged')),
  transmission_id TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_peppol_submissions_invoice
  ON peppol_submissions(invoice_document_id);
CREATE INDEX IF NOT EXISTS idx_peppol_submissions_reference
  ON peppol_submissions(submission_reference);

CREATE TRIGGER IF NOT EXISTS peppol_submissions_no_update
BEFORE UPDATE ON peppol_submissions
BEGIN
  SELECT RAISE(ABORT, 'peppol submissions are append-only audit records; record a new submission attempt instead');
END;

CREATE TRIGGER IF NOT EXISTS peppol_submissions_no_delete
BEFORE DELETE ON peppol_submissions
BEGIN
  SELECT RAISE(ABORT, 'peppol submissions are append-only audit records; record a new submission attempt instead');
END;

-- ===== GDPR (#184) =====
-- Append-only erasure tombstones. A GDPR erasure never UPDATEs/DELETEs the
-- append-only master-data rows or the ledger; instead it records one row per
-- redacted source record here. The GDPR export layer overlays these tombstones
-- so the redacted personal data never resurfaces. Keeping erasure as an
-- append-only journal means the audit chain and bookkeeping integrity are
-- untouched by a data-subject erasure.
CREATE TABLE IF NOT EXISTS gdpr_erasures (
  id INTEGER PRIMARY KEY,
  subject_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('customers','vendors','documents','bank_transactions')),
  source_row_id INTEGER NOT NULL,
  redacted_fields TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  retained_until_at_erasure TEXT,
  erased_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, source_row_id)
);

CREATE INDEX IF NOT EXISTS idx_gdpr_erasures_subject ON gdpr_erasures(subject_key);

CREATE TRIGGER IF NOT EXISTS gdpr_erasures_no_update
BEFORE UPDATE ON gdpr_erasures
BEGIN
  SELECT RAISE(ABORT, 'gdpr_erasures are append-only audit records; record a new erasure instead');
END;

CREATE TRIGGER IF NOT EXISTS gdpr_erasures_no_delete
BEFORE DELETE ON gdpr_erasures
BEGIN
  SELECT RAISE(ABORT, 'gdpr_erasures are append-only audit records; an erasure cannot be revoked');
END;
-- ===== END GDPR (#184) =====
