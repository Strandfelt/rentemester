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
  exemption_code TEXT
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY,
  transaction_date TEXT NOT NULL,
  booking_date TEXT,
  text TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'DKK',
  reference TEXT,
  source_file_hash TEXT,
  import_batch_id TEXT,
  transaction_hash TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'imported'
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY,
  entry_no TEXT NOT NULL UNIQUE,
  transaction_date TEXT NOT NULL,
  registration_datetime TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  text TEXT NOT NULL,
  source_bank_transaction_id INTEGER,
  document_id INTEGER,
  rule_version TEXT NOT NULL DEFAULT 'dk-v0.0.1',
  created_by TEXT NOT NULL DEFAULT 'system',
  created_by_program TEXT NOT NULL DEFAULT 'rentemester',
  status TEXT NOT NULL CHECK(status IN ('posted','reversed')) DEFAULT 'posted',
  reversal_of_entry_id INTEGER,
  previous_hash TEXT,
  entry_hash TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(source_bank_transaction_id) REFERENCES bank_transactions(id),
  FOREIGN KEY(document_id) REFERENCES documents(id)
);

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

CREATE TABLE IF NOT EXISTS exceptions (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  related_bank_transaction_id INTEGER,
  related_document_id INTEGER,
  message TEXT NOT NULL,
  required_action TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT
);

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
