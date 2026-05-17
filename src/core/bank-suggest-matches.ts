import type { Database } from "bun:sqlite";
import { getInvoiceStatus } from "./invoice-payments";

export type BankMatchSuggestion = {
  kind: "issued_invoice" | "purchase_sale";
  documentId: number;
  invoiceNo: string | null;
  supplierName?: string | null;
  customerName?: string | null;
  confidence: number;
  reasons: string[];
};

export type BankMatchSuggestionRow = {
  bankTransactionId: number;
  date: string;
  text: string;
  amount: number;
  currency: string;
  reference: string | null;
  suggestions: BankMatchSuggestion[];
};

export type SuggestBankMatchesResult = {
  ok: boolean;
  count: number;
  rows: BankMatchSuggestionRow[];
  errors: string[];
};

export type SuggestBankMatchesInput = {
  bankTransactionId?: number;
  max?: number;
};

function round2(value: number) {
  return Number(value.toFixed(2));
}

function daysBetween(a: string, b: string) {
  const from = new Date(`${a}T00:00:00Z`).getTime();
  const to = new Date(`${b}T00:00:00Z`).getTime();
  return Math.abs(Math.round((to - from) / 86400000));
}

function tokenize(value: string | null | undefined) {
  return Array.from(new Set((value ?? "")
    .toUpperCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)));
}

function overlapTokens(left: string | null | undefined, right: string | null | undefined) {
  const leftTokens = new Set(tokenize(left));
  return tokenize(right).filter((token) => leftTokens.has(token));
}

function combinedBankText(row: { text: string; reference: string | null }) {
  return `${row.text} ${row.reference ?? ""}`.trim().toUpperCase();
}

function unmatchedBankTransactions(db: Database, bankTransactionId?: number) {
  return db.query(
    `SELECT bt.id, bt.transaction_date, bt.text, bt.amount, bt.currency, bt.reference
     FROM bank_transactions bt
     LEFT JOIN journal_entries je
       ON je.source_bank_transaction_id = bt.id
      AND je.status = 'posted'
     WHERE je.id IS NULL
       AND (? IS NULL OR bt.id = ?)
     ORDER BY bt.transaction_date DESC, bt.id DESC`
  ).all(bankTransactionId ?? null, bankTransactionId ?? null) as Array<{
    id: number;
    transaction_date: string;
    text: string;
    amount: number;
    currency: string;
    reference: string | null;
  }>;
}

function openIssuedInvoices(db: Database) {
  return db.query(
    `SELECT id, invoice_no, invoice_date, payload_json
     FROM documents
     WHERE document_type = 'issued_invoice'
     ORDER BY id ASC`
  ).all() as Array<{
    id: number;
    invoice_no: string;
    invoice_date: string | null;
    payload_json: string | null;
  }>;
}

function openPurchaseDocuments(db: Database) {
  return db.query(
    `SELECT d.id, d.invoice_no, d.invoice_date, d.amount_inc_vat, d.sender_name, d.payment_details
     FROM documents d
     LEFT JOIN journal_entries je
       ON je.document_id = d.id
      AND je.status = 'posted'
     WHERE d.document_type = 'purchase_sale'
       AND d.currency = 'DKK'
       AND je.id IS NULL
     ORDER BY d.id ASC`
  ).all() as Array<{
    id: number;
    invoice_no: string | null;
    invoice_date: string | null;
    amount_inc_vat: number | null;
    sender_name: string | null;
    payment_details: string | null;
  }>;
}

function invoiceSuggestion(db: Database, bank: ReturnType<typeof unmatchedBankTransactions>[number], doc: ReturnType<typeof openIssuedInvoices>[number]): BankMatchSuggestion | null {
  if (!(Number(bank.amount) > 0)) return null;
  const status = getInvoiceStatus(db, doc.id, bank.transaction_date);
  if (!status.ok) return null;
  const openBalance = round2(Number(status.openBalance ?? 0));
  const claimOpenBalance = round2(Number(status.claimOpenBalance ?? 0));
  if (!(claimOpenBalance > 0)) return null;

  const payload = doc.payload_json ? JSON.parse(doc.payload_json) : null;
  const customerName = typeof payload?.buyer?.name === "string" ? payload.buyer.name : null;
  const bankText = combinedBankText(bank);
  let confidence = 0;
  const reasons: string[] = [];

  if (round2(Number(bank.amount)) === claimOpenBalance) {
    confidence += 0.6;
    reasons.push(`amount match: ${round2(Number(bank.amount))} vs claim open balance ${claimOpenBalance}`);
  } else if (round2(Number(bank.amount)) === openBalance) {
    confidence += 0.55;
    reasons.push(`amount match: ${round2(Number(bank.amount))} vs principal open balance ${openBalance}`);
  }

  if (doc.invoice_no && bankText.includes(doc.invoice_no.toUpperCase())) {
    confidence += 0.25;
    reasons.push(`invoice number '${doc.invoice_no}' found in bank text/reference`);
  }

  const sharedCustomerTokens = overlapTokens(bankText, customerName).slice(0, 3);
  if (sharedCustomerTokens.length > 0) {
    confidence += Math.min(0.15, sharedCustomerTokens.length * 0.05);
    reasons.push(`customer token match: ${sharedCustomerTokens.join(", ")}`);
  }

  if (doc.invoice_date) {
    const days = daysBetween(doc.invoice_date, bank.transaction_date);
    if (days <= 7) {
      confidence += 0.1;
      reasons.push(`date within ${days} days of invoice date`);
    }
  }

  if (confidence < 0.5) return null;
  return {
    kind: "issued_invoice",
    documentId: doc.id,
    invoiceNo: doc.invoice_no,
    customerName,
    confidence: round2(confidence),
    reasons,
  };
}

function purchaseSuggestion(bank: ReturnType<typeof unmatchedBankTransactions>[number], doc: ReturnType<typeof openPurchaseDocuments>[number]): BankMatchSuggestion | null {
  if (!(Number(bank.amount) < 0)) return null;
  const grossAmount = round2(Number(doc.amount_inc_vat ?? 0));
  if (!(grossAmount > 0)) return null;
  const paymentAmount = round2(Math.abs(Number(bank.amount)));
  const bankText = combinedBankText(bank);
  let confidence = 0;
  const reasons: string[] = [];

  if (paymentAmount === grossAmount) {
    confidence += 0.55;
    reasons.push(`amount match: ${paymentAmount} vs purchase gross amount ${grossAmount}`);
  }

  if (doc.invoice_no && bankText.includes(doc.invoice_no.toUpperCase())) {
    confidence += 0.2;
    reasons.push(`invoice number '${doc.invoice_no}' found in bank text/reference`);
  }

  const paymentDetailsTokens = overlapTokens(bankText, doc.payment_details).slice(0, 2);
  if (paymentDetailsTokens.length > 0) {
    confidence += 0.1;
    reasons.push(`payment-details token match: ${paymentDetailsTokens.join(", ")}`);
  }

  const sharedSupplierTokens = overlapTokens(bankText, doc.sender_name).slice(0, 3);
  if (sharedSupplierTokens.length > 0) {
    confidence += Math.min(0.2, sharedSupplierTokens.length * 0.1);
    reasons.push(`supplier token match: ${sharedSupplierTokens.join(", ")}`);
  }

  if (doc.invoice_date) {
    const days = daysBetween(doc.invoice_date, bank.transaction_date);
    if (days <= 7) {
      confidence += 0.05;
      reasons.push(`date within ${days} days of purchase invoice date`);
    }
  }

  if (confidence < 0.5) return null;
  return {
    kind: "purchase_sale",
    documentId: doc.id,
    invoiceNo: doc.invoice_no,
    supplierName: doc.sender_name,
    confidence: round2(confidence),
    reasons,
  };
}

export function suggestBankMatches(db: Database, input: SuggestBankMatchesInput = {}): SuggestBankMatchesResult {
  const errors: string[] = [];
  if (input.bankTransactionId !== undefined && (!Number.isInteger(input.bankTransactionId) || input.bankTransactionId <= 0)) {
    errors.push("bankTransactionId must be a positive integer when present");
  }
  const max = input.max ?? 5;
  if (!Number.isInteger(max) || max <= 0) errors.push("max must be a positive integer when present");
  if (errors.length > 0) return { ok: false, count: 0, rows: [], errors };

  const bankRows = unmatchedBankTransactions(db, input.bankTransactionId);
  if (input.bankTransactionId !== undefined && bankRows.length === 0) {
    return { ok: false, count: 0, rows: [], errors: [`unmatched bank transaction ${input.bankTransactionId} does not exist`] };
  }

  const invoiceDocs = openIssuedInvoices(db);
  const purchaseDocs = openPurchaseDocuments(db);

  const rows: BankMatchSuggestionRow[] = bankRows.map((bank) => {
    const suggestions = [
      ...invoiceDocs.map((doc) => invoiceSuggestion(db, bank, doc)).filter((value): value is BankMatchSuggestion => Boolean(value)),
      ...purchaseDocs.map((doc) => purchaseSuggestion(bank, doc)).filter((value): value is BankMatchSuggestion => Boolean(value)),
    ]
      .sort((a, b) => b.confidence - a.confidence || a.documentId - b.documentId)
      .slice(0, max);

    return {
      bankTransactionId: bank.id,
      date: bank.transaction_date,
      text: bank.text,
      amount: round2(Number(bank.amount)),
      currency: bank.currency,
      reference: bank.reference,
      suggestions,
    };
  });

  return { ok: true, count: rows.length, rows, errors: [] };
}
