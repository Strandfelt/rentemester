import type { Database } from "bun:sqlite";
import { postJournalEntry, type JournalPostResult } from "./ledger";
import { postEuServiceReverseChargePurchase, postRepresentationPurchase } from "./vat";
import { roundDkk } from "./money";

export type ExpenseVatTreatment = "standard" | "reverse_charge" | "representation" | "exempt";

export type BookExpenseFromBankInput = {
  documentId: number;
  bankTransactionId: number;
  expenseAccountNo: string;
  vatTreatment?: ExpenseVatTreatment;
  paymentAccountNo?: string;
  transactionDate?: string;
  text?: string;
  createdBy?: string;
  createdByProgram?: string;
};

export type BookExpenseFromBankResult = JournalPostResult & {
  documentId?: number;
  bankTransactionId?: number;
  grossAmount?: number;
  netAmount?: number;
  vatAmount?: number;
  vatTreatment?: ExpenseVatTreatment;
};


function inferVatTreatment(defaultVatCode: string | null): ExpenseVatTreatment {
  if (defaultVatCode === "EU_SERVICE_REVERSE_CHARGE") return "reverse_charge";
  if (defaultVatCode === "REPRESENTATION_SPECIAL") return "representation";
  if (defaultVatCode === "DK_PURCHASE_25") return "standard";
  return "exempt";
}

export function bookExpenseFromBank(db: Database, input: BookExpenseFromBankInput): BookExpenseFromBankResult {
  const errors: string[] = [];
  if (!Number.isInteger(input.documentId) || input.documentId <= 0) errors.push("documentId must be a positive integer");
  if (!Number.isInteger(input.bankTransactionId) || input.bankTransactionId <= 0) errors.push("bankTransactionId must be a positive integer");
  if (typeof input.expenseAccountNo !== "string" || input.expenseAccountNo.trim().length === 0) errors.push("expenseAccountNo is required");
  if (input.vatTreatment && !["standard", "reverse_charge", "representation", "exempt"].includes(input.vatTreatment)) {
    errors.push("vatTreatment must be one of standard, reverse_charge, representation, exempt when present");
  }
  if (errors.length > 0) return { ok: false, appliedRules: [], errors };

  const account = db.query(`SELECT account_no, type, default_vat_code, active FROM accounts WHERE account_no = ?`).get(input.expenseAccountNo.trim()) as {
    account_no: string;
    type: string;
    default_vat_code: string | null;
    active: number;
  } | null;
  if (!account) return { ok: false, appliedRules: [], errors: [`expense account ${input.expenseAccountNo} does not exist`] };
  if (account.type !== "expense") return { ok: false, appliedRules: [], errors: [`account ${input.expenseAccountNo} is not an expense account`] };
  if (!account.active) return { ok: false, appliedRules: [], errors: [`account ${input.expenseAccountNo} is inactive`] };

  const document = db.query(
    `SELECT id, document_type, invoice_no, invoice_date, amount_inc_vat, vat_amount, currency, sender_name
     FROM documents
     WHERE id = ?`
  ).get(input.documentId) as {
    id: number;
    document_type: string;
    invoice_no: string | null;
    invoice_date: string | null;
    amount_inc_vat: number | null;
    vat_amount: number | null;
    currency: string;
    sender_name: string | null;
  } | null;
  if (!document) return { ok: false, appliedRules: [], errors: [`document ${input.documentId} does not exist`] };
  if (document.document_type !== "purchase_sale" && document.document_type !== "cash_register_receipt") {
    return { ok: false, appliedRules: [], errors: [`document ${input.documentId} is not a purchase document`] };
  }
  if (document.currency !== "DKK") {
    return { ok: false, appliedRules: [], errors: [`document ${input.documentId} must be in DKK for expense book`] };
  }
  const grossAmount = roundDkk(Number(document.amount_inc_vat ?? 0));
  const vatAmount = roundDkk(Number(document.vat_amount ?? 0));
  if (!(grossAmount > 0)) return { ok: false, appliedRules: [], errors: [`document ${input.documentId} must have amount_inc_vat > 0`] };
  if (vatAmount < 0 || vatAmount > grossAmount) return { ok: false, appliedRules: [], errors: [`document ${input.documentId} has invalid vat_amount ${vatAmount}`] };

  const bank = db.query(`SELECT id, transaction_date, amount, text FROM bank_transactions WHERE id = ?`).get(input.bankTransactionId) as {
    id: number;
    transaction_date: string;
    amount: number;
    text: string;
  } | null;
  if (!bank) return { ok: false, appliedRules: [], errors: [`bank transaction ${input.bankTransactionId} does not exist`] };
  if (!(Number(bank.amount) < 0)) return { ok: false, appliedRules: [], errors: [`bank transaction ${input.bankTransactionId} is not an outgoing payment`] };

  const existingJournal = db.query(`SELECT id FROM journal_entries WHERE source_bank_transaction_id = ? LIMIT 1`).get(bank.id) as { id: number } | null;
  if (existingJournal) return { ok: false, appliedRules: [], errors: [`bank transaction ${bank.id} is already linked to journal entry ${existingJournal.id}`] };

  const vatTreatment = input.vatTreatment ?? inferVatTreatment(account.default_vat_code);
  const transactionDate = input.transactionDate ?? bank.transaction_date;
  const text = input.text?.trim() || `${document.sender_name ?? "Expense"} from bank transaction ${bank.id}`;
  const paymentAccountNo = input.paymentAccountNo ?? "2000";
  const paymentAmount = roundDkk(Math.abs(Number(bank.amount)));

  if (paymentAmount !== grossAmount) {
    return { ok: false, appliedRules: [], errors: [`bank transaction amount ${paymentAmount} does not match document gross amount ${grossAmount}`] };
  }

  if (vatTreatment === "standard") {
    if (!(vatAmount > 0)) return { ok: false, appliedRules: [], errors: ["standard expense booking requires document vat_amount > 0"] };
    const netAmount = roundDkk(grossAmount - vatAmount);
    const result = postJournalEntry(db, {
      transactionDate,
      text,
      documentId: input.documentId,
      sourceBankTransactionId: input.bankTransactionId,
      createdBy: input.createdBy,
      createdByProgram: input.createdByProgram,
      lines: [
        { accountNo: account.account_no, debitAmount: netAmount, vatCode: "DK_PURCHASE_25", text: document.invoice_no ?? "Expense base" },
        { accountNo: "4000", debitAmount: vatAmount, text: "Input VAT" },
        { accountNo: paymentAccountNo, creditAmount: grossAmount, text: bank.text },
      ],
    });
    return { ...result, documentId: input.documentId, bankTransactionId: input.bankTransactionId, grossAmount, netAmount, vatAmount, vatTreatment };
  }

  if (vatTreatment === "reverse_charge") {
    if (vatAmount !== 0) return { ok: false, appliedRules: [], errors: ["reverse-charge expense booking requires document vat_amount = 0"] };
    const result = postEuServiceReverseChargePurchase(db, {
      transactionDate,
      text,
      documentId: input.documentId,
      netAmount: grossAmount,
      expenseAccountNo: account.account_no,
      paymentAccountNo,
      sourceBankTransactionId: input.bankTransactionId,
      createdBy: input.createdBy,
      createdByProgram: input.createdByProgram,
    });
    return { ...result, documentId: input.documentId, bankTransactionId: input.bankTransactionId, grossAmount, netAmount: grossAmount, vatAmount: 0, vatTreatment };
  }

  if (vatTreatment === "representation") {
    if (!(vatAmount > 0)) return { ok: false, appliedRules: [], errors: ["representation expense booking requires document vat_amount > 0"] };
    const netAmount = roundDkk(grossAmount - vatAmount);
    const result = postRepresentationPurchase(db, {
      transactionDate,
      text,
      documentId: input.documentId,
      netAmount,
      expenseAccountNo: account.account_no,
      paymentAccountNo,
      sourceBankTransactionId: input.bankTransactionId,
      createdBy: input.createdBy,
      createdByProgram: input.createdByProgram,
    });
    return { ...result, documentId: input.documentId, bankTransactionId: input.bankTransactionId, grossAmount, netAmount, vatAmount, vatTreatment };
  }

  if (vatAmount !== 0) return { ok: false, appliedRules: [], errors: ["exempt expense booking requires document vat_amount = 0"] };
  const result = postJournalEntry(db, {
    transactionDate,
    text,
    documentId: input.documentId,
    sourceBankTransactionId: input.bankTransactionId,
    createdBy: input.createdBy,
    createdByProgram: input.createdByProgram,
    lines: [
      { accountNo: account.account_no, debitAmount: grossAmount, text: document.invoice_no ?? "Expense" },
      { accountNo: paymentAccountNo, creditAmount: grossAmount, text: bank.text },
    ],
  });
  return { ...result, documentId: input.documentId, bankTransactionId: input.bankTransactionId, grossAmount, netAmount: grossAmount, vatAmount: 0, vatTreatment };
}
