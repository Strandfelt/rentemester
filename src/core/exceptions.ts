import type { Database } from "bun:sqlite";

export type ExceptionSeverity = "low" | "medium" | "high";
export type ExceptionStatus = "open" | "resolved" | "all";

export type RecordExceptionInput = {
  type: string;
  severity?: ExceptionSeverity;
  relatedBankTransactionId?: number | null;
  relatedDocumentId?: number | null;
  message: string;
  requiredAction?: string | null;
  sourceEvidence?: unknown;
  postingPreview?: unknown;
};

export type ListExceptionsInput = {
  status?: ExceptionStatus;
};

export type ResolveExceptionInput = {
  id: number;
  note?: string | null;
  resolvedBy?: string | null;
};

function serializeJson(value: unknown) {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function parseJson<T = unknown>(value: string | null) {
  if (!value) return null as T | null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
}

function normalizeStatus(status?: ExceptionStatus) {
  if (!status || status === "open" || status === "resolved" || status === "all") return status ?? "open";
  return null;
}

export function recordException(db: Database, input: RecordExceptionInput) {
  const errors: string[] = [];
  const severity = input.severity ?? "medium";
  if (!["low", "medium", "high"].includes(severity)) errors.push("severity must be low, medium, or high");
  if (!input.type?.trim()) errors.push("type is required");
  if (!input.message?.trim()) errors.push("message is required");
  if (errors.length > 0) return { ok: false, exceptionId: undefined, duplicate: false, errors };

  const message = input.message.trim();
  const requiredAction = input.requiredAction?.trim() || null;
  const sourceEvidence = serializeJson(input.sourceEvidence);
  const postingPreview = serializeJson(input.postingPreview);

  const existing = db.query(
    `SELECT id
     FROM exceptions
     WHERE status = 'open'
       AND type = ?
       AND COALESCE(related_bank_transaction_id, 0) = COALESCE(?, 0)
       AND COALESCE(related_document_id, 0) = COALESCE(?, 0)
       AND message = ?
       AND COALESCE(required_action, '') = COALESCE(?, '')
     LIMIT 1`
  ).get(
    input.type.trim(),
    input.relatedBankTransactionId ?? null,
    input.relatedDocumentId ?? null,
    message,
    requiredAction,
  ) as { id: number } | null;

  if (existing) return { ok: true, exceptionId: existing.id, duplicate: true, errors: [] };

  const row = db.query(
    `INSERT INTO exceptions (
      type, severity, status, related_bank_transaction_id, related_document_id,
      message, required_action, source_evidence, posting_preview
    ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?)
    RETURNING id`
  ).get(
    input.type.trim(),
    severity,
    input.relatedBankTransactionId ?? null,
    input.relatedDocumentId ?? null,
    message,
    requiredAction,
    sourceEvidence,
    postingPreview,
  ) as { id: number };

  return { ok: true, exceptionId: row.id, duplicate: false, errors: [] };
}

export function listExceptions(db: Database, input: ListExceptionsInput = {}) {
  const status = normalizeStatus(input.status);
  if (!status) return { ok: false, count: 0, rows: [], errors: ["status must be open, resolved, or all when present"] };

  const rows = db.query(
    `SELECT id, type, severity, status, related_bank_transaction_id, related_document_id,
            message, required_action, source_evidence, posting_preview,
            created_at, resolved_at, resolved_by, resolution_note
     FROM exceptions
     WHERE (? = 'all' OR status = ?)
     ORDER BY id DESC`
  ).all(status, status) as Array<any>;

  return {
    ok: true,
    count: rows.length,
    rows: rows.map((row) => ({
      id: row.id,
      type: row.type,
      severity: row.severity,
      status: row.status,
      relatedBankTransactionId: row.related_bank_transaction_id,
      relatedDocumentId: row.related_document_id,
      message: row.message,
      requiredAction: row.required_action,
      sourceEvidence: parseJson(row.source_evidence),
      postingPreview: parseJson(row.posting_preview),
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
      resolutionNote: row.resolution_note,
    })),
    errors: [],
  };
}

export function resolveException(db: Database, input: ResolveExceptionInput) {
  const errors: string[] = [];
  if (!Number.isInteger(input.id) || input.id <= 0) errors.push("id must be a positive integer");
  if (errors.length > 0) return { ok: false, resolved: false, errors };

  const row = db.query(`SELECT id, status FROM exceptions WHERE id = ? LIMIT 1`).get(input.id) as { id: number; status: string } | null;
  if (!row) return { ok: false, resolved: false, errors: [`exception ${input.id} does not exist`] };
  if (row.status === "resolved") return { ok: true, resolved: false, errors: [] };

  db.run(
    `UPDATE exceptions
     SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolved_by = ?, resolution_note = ?
     WHERE id = ?`,
    input.resolvedBy ?? null,
    input.note?.trim() || null,
    input.id,
  );

  return { ok: true, resolved: true, errors: [] };
}

export function resolveOpenExceptionsForBankTransaction(db: Database, bankTransactionId: number, note?: string | null, resolvedBy?: string | null) {
  if (!Number.isInteger(bankTransactionId) || bankTransactionId <= 0) return { ok: false, resolvedCount: 0, errors: ["bankTransactionId must be a positive integer"] };
  const openRows = db.query(
    `SELECT id
     FROM exceptions
     WHERE type = 'UNMATCHED_BANK_TRANSACTION'
       AND status = 'open'
       AND related_bank_transaction_id = ?`
  ).all(bankTransactionId) as Array<{ id: number }>;

  for (const row of openRows) {
    db.run(
      `UPDATE exceptions
       SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolved_by = ?, resolution_note = ?
       WHERE id = ?`,
      resolvedBy ?? null,
      note?.trim() || "Resolved automatically when bank transaction was linked to a posted journal entry",
      row.id,
    );
  }

  return { ok: true, resolvedCount: openRows.length, errors: [] };
}

export function syncUnmatchedBankTransactionExceptions(db: Database) {
  const unmatchedRows = db.query(
    `SELECT bt.id, bt.transaction_date, bt.booking_date, bt.text, bt.amount, bt.currency, bt.reference, bt.import_batch_id
     FROM bank_transactions bt
     LEFT JOIN journal_entries je
       ON je.source_bank_transaction_id = bt.id
      AND je.status = 'posted'
     LEFT JOIN exceptions ex
       ON ex.related_bank_transaction_id = bt.id
      AND ex.type = 'UNMATCHED_BANK_TRANSACTION'
      AND ex.status = 'open'
     WHERE je.id IS NULL
       AND ex.id IS NULL
     ORDER BY bt.transaction_date ASC, bt.id ASC`
  ).all() as Array<any>;

  let created = 0;
  for (const row of unmatchedRows) {
    const result = recordException(db, {
      type: "UNMATCHED_BANK_TRANSACTION",
      severity: "medium",
      relatedBankTransactionId: row.id,
      message: `Bank transaction ${row.id} is still unmatched`,
      requiredAction: "Review bank transaction, run suggest-matches, then settle or book it.",
      sourceEvidence: {
        bankTransactionId: row.id,
        transactionDate: row.transaction_date,
        bookingDate: row.booking_date,
        text: row.text,
        amount: Number(row.amount),
        currency: row.currency,
        reference: row.reference,
        importBatchId: row.import_batch_id,
      },
      postingPreview: {
        nextStep: "bank suggest-matches",
        bankTransactionId: row.id,
      },
    });
    if (result.ok && !result.duplicate) created += 1;
  }

  return { ok: true, created, errors: [] };
}
