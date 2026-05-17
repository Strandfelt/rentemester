import type { Database } from "bun:sqlite";
import { postJournalEntry, type JournalPostResult } from "./ledger";

const RULE_ID = "DK-INVOICE-BOOKKEEPING-001";

export type PostIssuedInvoiceInput = {
  invoiceDocumentId: number;
  transactionDate?: string;
  receivableAccountNo?: string;
  revenueAccountNo?: string;
  outputVatAccountNo?: string;
  createdBy?: string;
  createdByProgram?: string;
};

function round2(value: number) {
  return Number(value.toFixed(2));
}

export function postIssuedInvoiceToLedger(db: Database, input: PostIssuedInvoiceInput): JournalPostResult {
  if (!Number.isInteger(input.invoiceDocumentId) || input.invoiceDocumentId <= 0) {
    return { ok: false, appliedRules: [RULE_ID], errors: ["invoiceDocumentId must be a positive integer"] };
  }

  const doc = db.query(
    `SELECT id, invoice_no, invoice_date, amount_inc_vat, currency, vat_amount, payload_json, document_type
     FROM documents WHERE id = ?`
  ).get(input.invoiceDocumentId) as {
    id: number;
    invoice_no: string;
    invoice_date: string | null;
    amount_inc_vat: number | null;
    currency: string;
    vat_amount: number | null;
    payload_json: string | null;
    document_type: string;
  } | null;

  if (!doc) return { ok: false, appliedRules: [RULE_ID], errors: [`invoice document ${input.invoiceDocumentId} does not exist`] };
  if (doc.document_type !== "issued_invoice") return { ok: false, appliedRules: [RULE_ID], errors: [`document ${input.invoiceDocumentId} is not an issued invoice`] };
  if ((doc.currency ?? "DKK") !== "DKK") return { ok: false, appliedRules: [RULE_ID], errors: ["only DKK issued invoices are supported in the current sales posting flow"] };

  const existing = db.query("SELECT id, entry_no FROM journal_entries WHERE document_id = ? AND reversal_of_entry_id IS NULL LIMIT 1").get(input.invoiceDocumentId) as { id: number; entry_no: string } | null;
  if (existing) {
    return { ok: false, appliedRules: [RULE_ID], errors: [`invoice ${doc.invoice_no} already has journal entry ${existing.entry_no}`] };
  }

  const payload = doc.payload_json ? JSON.parse(doc.payload_json) : null;
  const grossAmount = round2(Number(doc.amount_inc_vat ?? payload?.totals?.grossAmount ?? 0));
  const vatAmount = round2(Number(doc.vat_amount ?? payload?.totals?.vatAmount ?? 0));
  const netAmount = round2(grossAmount - vatAmount);

  if (!(grossAmount > 0)) return { ok: false, appliedRules: [RULE_ID], errors: [`invoice ${doc.invoice_no} is missing gross amount`] };
  if (netAmount <= 0) return { ok: false, appliedRules: [RULE_ID], errors: [`invoice ${doc.invoice_no} produced invalid net amount`] };

  const journal = postJournalEntry(db, {
    transactionDate: input.transactionDate ?? doc.invoice_date ?? payload?.issueDate,
    text: `Issued invoice ${doc.invoice_no}`,
    documentId: input.invoiceDocumentId,
    createdBy: input.createdBy,
    createdByProgram: input.createdByProgram,
    lines: [
      { accountNo: input.receivableAccountNo ?? "1100", debitAmount: grossAmount, text: `Receivable ${doc.invoice_no}` },
      { accountNo: input.revenueAccountNo ?? "1000", creditAmount: netAmount, vatCode: "DK_SALE_25", text: `Revenue ${doc.invoice_no}` },
      { accountNo: input.outputVatAccountNo ?? "1200", creditAmount: vatAmount, text: `Output VAT ${doc.invoice_no}` },
    ],
  });

  return {
    ...journal,
    appliedRules: [...new Set([...(journal.appliedRules ?? []), RULE_ID])],
  };
}
