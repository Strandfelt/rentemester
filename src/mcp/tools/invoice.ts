/**
 * MCP-tools for fakturaer (issued invoices).
 *
 * Read:
 *   - invoice_status, invoice_list, invoice_find, invoice_overdue
 *   - invoice_interest_calc, invoice_compensation_calc
 *   - invoice_validate
 *
 * Write-irreversible:
 *   - invoice_issue, invoice_post, invoice_render
 *   - invoice_credit_note, invoice_settle_bank, invoice_settle_claim_bank
 *   - invoice_write_off_bad_debt, invoice_apply_payment, invoice_refund_bank
 *   - invoice_remind, invoice_post_reminder
 *   - invoice_claim_interest, invoice_post_interest
 *   - invoice_claim_compensation, invoice_post_compensation
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateInvoice, type InvoicePayload } from "../../core/invoice";
import { issueInvoice } from "../../core/issued-invoices";
import { resolveInvoiceMasterData } from "../../core/master-data";
import { postIssuedInvoiceToLedger } from "../../core/invoice-booking";
import { renderIssuedInvoicePdf } from "../../core/invoice-pdf";
import { issueCreditNote, type IssueCreditNoteInput } from "../../core/credit-notes";
import { settleInvoiceFromBank, type SettleInvoiceFromBankInput } from "../../core/invoice-settlement";
import {
  settleInvoiceClaimsFromBank,
  type SettleInvoiceClaimsFromBankInput,
} from "../../core/invoice-claim-settlement";
import { writeOffInvoiceBadDebt, type WriteOffInvoiceBadDebtInput } from "../../core/invoice-bad-debt";
import {
  applyInvoicePayment,
  getInvoiceStatus,
  type ApplyInvoicePaymentInput,
} from "../../core/invoice-payments";
import { refundInvoiceToBank, type RefundInvoiceToBankInput } from "../../core/invoice-refunds";
import {
  registerInvoiceReminder,
  postInvoiceReminderToLedger,
} from "../../core/invoice-reminders";
import {
  calculateInvoiceLateInterest,
  registerInvoiceLateInterest,
  postInvoiceLateInterestToLedger,
} from "../../core/invoice-interest";
import {
  calculateInvoiceLateCompensation,
  registerInvoiceLateCompensation,
  postInvoiceLateCompensationToLedger,
} from "../../core/invoice-compensation";
import {
  buildInvoiceList,
  findInvoices,
  buildOverdueInvoiceList,
  type InvoiceQueryStatus,
} from "../../core/invoice-list";
import { wrapCoreResult, errorEnvelope } from "../envelope";
import {
  withCompanyDb,
  withCompanyDbConfirmed,
  resolveIssuedInvoiceDocumentId,
  confirmField,
} from "../tool-runtime";

// --------------------------------------------------------------- payload schemas
// All monetary fields are in kroner — decimal DKK with 2 decimals (NOT øre).
// VAT rates are fractions (0.25 = 25%). FX rates are major-unit → DKK (e.g. 7.46).

const invoiceLineSchema = z.object({
  description: z
    .string()
    .describe("Description of the good or service. Required on every line."),
  quantity: z.number().optional().describe("Quantity of the line item."),
  unitPriceExVat: z
    .number()
    .optional()
    .describe("Unit price excluding VAT, in kroner (decimal DKK)."),
  lineTotalExVat: z
    .number()
    .optional()
    .describe(
      "Line total excluding VAT, in kroner (decimal DKK). Must equal quantity * unitPriceExVat.",
    ),
});

const invoiceTotalsSchema = z.object({
  netAmount: z
    .number()
    .optional()
    .describe(
      "Total excluding VAT, in kroner (decimal DKK). Required for full invoices; " +
        "must equal the sum of all lines' lineTotalExVat.",
    ),
  vatRate: z
    .number()
    .optional()
    .describe("VAT rate as a fraction (0.25 = 25%). Required for standard-VAT invoices; must be omitted for reverse-charge invoices."),
  vatAmount: z
    .number()
    .optional()
    .describe(
      "Total VAT, in kroner (decimal DKK). Required for standard-VAT invoices; " +
        "must be omitted for reverse-charge invoices.",
    ),
  grossAmount: z
    .number()
    .optional()
    .describe(
      "Total including VAT, in kroner (decimal DKK). Required. For standard VAT it must " +
        "equal netAmount + vatAmount; for reverse charge it must equal netAmount.",
    ),
  fxRateToDkk: z
    .number()
    .optional()
    .describe("For non-DKK invoices: FX rate from invoice currency to DKK (e.g. 7.46)."),
  netAmountDkk: z
    .number()
    .optional()
    .describe("For non-DKK invoices: netAmount converted to kroner (decimal DKK). Must equal netAmount * fxRateToDkk."),
  vatAmountDkk: z
    .number()
    .optional()
    .describe("For non-DKK standard-VAT invoices: vatAmount converted to kroner (decimal DKK). Must equal vatAmount * fxRateToDkk."),
  grossAmountDkk: z
    .number()
    .optional()
    .describe("For non-DKK invoices: grossAmount converted to kroner (decimal DKK). Must equal grossAmount * fxRateToDkk."),
  vatComputationBasis: z
    .string()
    .optional()
    .describe("Optional VAT computation basis, e.g. 'VAT_20_OF_GROSS' for simplified invoices."),
});

const invoicePartySchema = z.object({
  name: z.string().optional().describe("Party name."),
  address: z.string().optional().describe("Party postal address."),
  vatOrCvr: z.string().optional().describe("Party VAT or CVR number, e.g. 'DK12345678'."),
});

const invoiceBuyerSchema = z.object({
  name: z.string().optional().describe("Buyer name. Required for full invoices."),
  address: z.string().optional().describe("Buyer postal address. Required for full invoices."),
  vatOrCvr: z
    .string()
    .optional()
    .describe("Buyer VAT or CVR number. Required for foreign reverse-charge invoices."),
  eanNumber: z
    .string()
    .optional()
    .describe("13-digit EAN/GLN number — required when invoicing a Danish public-sector recipient."),
  publicRecipient: z
    .boolean()
    .optional()
    .describe("Set true when the buyer is a Danish public-sector body (forces full invoice + EAN)."),
});

const invoicePayloadSchema = z
  .object({
    invoiceType: z
      .enum(["full", "simplified"])
      .describe("'full' for a full invoice; 'simplified' only for gross totals up to DKK 3,000."),
    vatTreatment: z
      .enum(["standard", "domestic_reverse_charge", "foreign_reverse_charge"])
      .optional()
      .describe("VAT treatment (default 'standard'). Reverse-charge variants also require reverseChargeBasis."),
    issueDate: z.string().optional().describe("Invoice issue date in YYYY-MM-DD format. Required."),
    invoiceNumber: z
      .string()
      .optional()
      .describe("Optional explicit invoice number. If omitted, a sequential number is assigned."),
    seller: invoicePartySchema
      .optional()
      .describe("Seller details. seller.name, seller.address and seller.vatOrCvr are all required."),
    buyer: invoiceBuyerSchema.optional().describe("Buyer details."),
    lines: z
      .array(invoiceLineSchema)
      .optional()
      .describe("Invoice lines — at least one line with a description is required."),
    totals: invoiceTotalsSchema
      .optional()
      .describe("Invoice totals. All amounts are in kroner (decimal DKK)."),
    reverseChargeBasis: z
      .enum([
        "DK_MOMSLOVEN_§46_STK_1_NR_3",
        "DK_MOMSLOVEN_§46_STK_1_NR_6",
        "DK_MOMSLOVEN_§46_STK_1_NR_7",
        "EU_MOMSDIREKTIV_ART_196",
        "EU_MOMSDIREKTIV_ART_199",
      ])
      .optional()
      .describe("Legal basis for reverse charge — required for reverse-charge invoices."),
    reverseChargeNote: z
      .string()
      .optional()
      .describe("Optional free-text note explaining the reverse-charge treatment."),
    currency: z
      .string()
      .optional()
      .describe("3-letter ISO currency code (default 'DKK'). Non-DKK invoices require the *Dkk total fields and fxRateToDkk."),
    dueDate: z.string().optional().describe("Payment due date in YYYY-MM-DD format; cannot be earlier than issueDate."),
    deliveryDate: z.string().optional().describe("Delivery date in YYYY-MM-DD format. Use this OR the deliveryPeriod fields, not both."),
    deliveryPeriodStart: z
      .string()
      .optional()
      .describe("Start of the delivery period in YYYY-MM-DD format. Must be provided together with deliveryPeriodEnd."),
    deliveryPeriodEnd: z
      .string()
      .optional()
      .describe("End of the delivery period in YYYY-MM-DD format. Must be provided together with deliveryPeriodStart."),
  })
  .describe(
    "Danish customer-invoice payload. All monetary amounts are in kroner " +
      "(decimal DKK, 2 decimals — NOT øre); vatRate is a fraction (0.25 = 25%).",
  );

// --- credit note -------------------------------------------------------------
const creditNotePayloadSchema = z
  .object({
    originalInvoiceDocumentId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Document ID of the invoice being credited. Provide this OR originalInvoiceNumber."),
    originalInvoiceNumber: z
      .string()
      .optional()
      .describe("Invoice number of the invoice being credited. Provide this OR originalInvoiceDocumentId."),
    issueDate: z.string().describe("Credit-note issue date in YYYY-MM-DD format."),
    reason: z.string().describe("Reason for the credit note."),
    grossAmount: z
      .number()
      .optional()
      .describe(
        "Amount to credit including VAT, in kroner (decimal DKK). Defaults to the full " +
          "remaining creditable amount; may not exceed it.",
      ),
    creditNoteNumber: z
      .string()
      .optional()
      .describe("Optional explicit credit-note number. If omitted, a sequential number is assigned."),
  })
  .describe("Credit-note payload. grossAmount is in kroner (decimal DKK, 2 decimals — NOT øre).");

// --- bank-settlement family --------------------------------------------------
// invoice_settle_bank, invoice_settle_claim_bank and invoice_refund_bank share
// the same shape: they match an existing bank transaction against an invoice.
const bankSettlementPayloadSchema = z
  .object({
    invoiceDocumentId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Document ID of the invoice. Provide this OR invoiceNumber."),
    invoiceNumber: z
      .string()
      .optional()
      .describe("Invoice number. Provide this OR invoiceDocumentId."),
    bankTransactionId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("ID of the bank transaction to match. Provide this OR bankTransactionReference. See bank_list."),
    bankTransactionReference: z
      .string()
      .optional()
      .describe("Reference of the bank transaction to match. Provide this OR bankTransactionId."),
    paymentDate: z
      .string()
      .optional()
      .describe("Payment/settlement date in YYYY-MM-DD format. Defaults to the bank transaction's date."),
    amount: z
      .number()
      .optional()
      .describe(
        "Amount to settle, in kroner (decimal DKK, 2 decimals — NOT øre). Defaults to the " +
          "full bank-transaction amount.",
      ),
    bankAccountNo: z
      .string()
      .optional()
      .describe("Optional bank account number from the chart of accounts to post against."),
    receivableAccountNo: z
      .string()
      .optional()
      .describe("Optional accounts-receivable account number from the chart of accounts."),
  })
  .describe("Bank-settlement payload. amount is in kroner (decimal DKK, 2 decimals — NOT øre).");

const refundBankPayloadSchema = bankSettlementPayloadSchema
  .extend({
    refundDate: z
      .string()
      .optional()
      .describe("Refund date in YYYY-MM-DD format. Defaults to the bank transaction's date."),
  })
  .describe("Refund-to-bank payload. amount is in kroner (decimal DKK, 2 decimals — NOT øre).");

// --- bad-debt write-off ------------------------------------------------------
const badDebtPayloadSchema = z
  .object({
    invoiceDocumentId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Document ID of the invoice. Provide this OR invoiceNumber."),
    invoiceNumber: z
      .string()
      .optional()
      .describe("Invoice number. Provide this OR invoiceDocumentId."),
    writeOffDate: z.string().describe("Write-off date in YYYY-MM-DD format."),
    grossAmount: z
      .number()
      .optional()
      .describe(
        "Amount to write off including VAT, in kroner (decimal DKK, 2 decimals — NOT øre). " +
          "Defaults to the full open principal balance; may not exceed it.",
      ),
    expenseAccountNo: z
      .string()
      .optional()
      .describe("Optional bad-debt expense account number from the chart of accounts."),
    receivableAccountNo: z
      .string()
      .optional()
      .describe("Optional accounts-receivable account number from the chart of accounts."),
    vatAccountNo: z
      .string()
      .optional()
      .describe("Optional VAT account number from the chart of accounts for the VAT relief."),
    note: z.string().optional().describe("Optional free-text note."),
  })
  .describe("Bad-debt write-off payload. grossAmount is in kroner (decimal DKK, 2 decimals — NOT øre).");

// --- apply payment -----------------------------------------------------------
const applyPaymentPayloadSchema = z
  .object({
    invoiceDocumentId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Document ID of the invoice. Provide this OR invoiceNumber."),
    invoiceNumber: z
      .string()
      .optional()
      .describe("Invoice number. Provide this OR invoiceDocumentId."),
    paymentDate: z.string().describe("Payment date in YYYY-MM-DD format."),
    amount: z
      .number()
      .describe("Payment amount, in kroner (decimal DKK, 2 decimals — NOT øre)."),
    bankTransactionId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional ID of the linked bank transaction. See bank_list."),
    journalEntryId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional ID of an existing journal entry to link the payment to."),
    bankAccountNo: z
      .string()
      .optional()
      .describe("Optional bank account number from the chart of accounts to post against."),
    receivableAccountNo: z
      .string()
      .optional()
      .describe("Optional accounts-receivable account number from the chart of accounts."),
    note: z.string().optional().describe("Optional free-text note."),
  })
  .describe("Apply-payment payload. amount is in kroner (decimal DKK, 2 decimals — NOT øre).");

const statusEnum = z
  .enum(["open", "paid", "credited", "refunded", "overpaid", "written_off", "overdue", "all"])
  .optional();

const docIdOrNumberSchema = {
  company: z.string().min(1),
  documentId: z.number().int().positive().optional(),
  invoiceNumber: z.string().optional(),
};

function notFoundEnvelope(args: { documentId?: number | null; invoiceNumber?: string | null }) {
  return errorEnvelope(
    `Could not resolve invoice: provide documentId or invoiceNumber (got documentId=${args.documentId ?? "-"}, invoiceNumber='${args.invoiceNumber ?? ""}')`,
  );
}

export function registerInvoiceTools(server: McpServer): void {
  // --------------------------------------------------------------- read tools

  server.registerTool(
    "invoice_validate",
    {
      title: "Validate invoice payload",
      description:
        "Validerer faktura-payload uden at gemme. Read-only. " +
        "Alle beløb er i kroner (decimal DKK, 2 decimaler — ikke øre); vatRate er en brøk (0.25 = 25%).",
      inputSchema: { payload: invoicePayloadSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ payload }) => {
      const result = validateInvoice(payload as InvoicePayload);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(wrapCoreResult(result)) }],
        isError: !result.ok,
        structuredContent: wrapCoreResult(result),
      };
    },
  );

  server.registerTool(
    "invoice_status",
    {
      title: "Invoice status",
      description: "Viser åben saldo og status på en faktura. Read-only.",
      inputSchema: { ...docIdOrNumberSchema, asOf: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    withCompanyDb<{ company: string; documentId?: number; invoiceNumber?: string; asOf?: string }>(
      server,
      ({ db, args }) => {
        const id = resolveIssuedInvoiceDocumentId(db, args);
        if (!id) return notFoundEnvelope(args);
        const result = getInvoiceStatus(db, id, args.asOf);
        return wrapCoreResult(result);
      },
    ),
  );

  server.registerTool(
    "invoice_list",
    {
      title: "List invoices",
      description: "Lister udstedte fakturaer med filtre. Read-only.",
      inputSchema: {
        company: z.string().min(1),
        status: statusEnum,
        from: z.string().optional(),
        to: z.string().optional(),
        customerCvr: z.string().optional(),
        customer: z.string().optional(),
        invoiceNumber: z.string().optional(),
        minAmount: z.number().optional(),
        maxAmount: z.number().optional(),
        asOf: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    withCompanyDb<{
      company: string;
      status?: InvoiceQueryStatus;
      from?: string;
      to?: string;
      customerCvr?: string;
      customer?: string;
      invoiceNumber?: string;
      minAmount?: number;
      maxAmount?: number;
      asOf?: string;
    }>(server, ({ db, args }) => {
      const result = buildInvoiceList(db, {
        status: args.status ?? "all",
        from: args.from,
        to: args.to,
        customerCvr: args.customerCvr,
        customer: args.customer,
        invoiceNumber: args.invoiceNumber,
        minAmount: args.minAmount,
        maxAmount: args.maxAmount,
        asOfDate: args.asOf,
      });
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_find",
    {
      title: "Find invoices",
      description: "Søger fakturaer på nummer, kunde eller beløb. Read-only.",
      inputSchema: {
        company: z.string().min(1),
        query: z.string().optional(),
        customer: z.string().optional(),
        invoiceNumber: z.string().optional(),
        amount: z.number().optional(),
        asOf: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    withCompanyDb<{
      company: string;
      query?: string;
      customer?: string;
      invoiceNumber?: string;
      amount?: number;
      asOf?: string;
    }>(server, ({ db, args }) => {
      const result = findInvoices(db, {
        query: args.query,
        customer: args.customer,
        invoiceNumber: args.invoiceNumber,
        minAmount: args.amount,
        maxAmount: args.amount,
        asOfDate: args.asOf,
      });
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_overdue",
    {
      title: "List overdue invoices",
      description: "Lister forfaldne udstedte fakturaer som ikke er fuldt afregnet. Read-only.",
      inputSchema: {
        company: z.string().min(1),
        asOf: z.string().optional(),
        minDays: z.number().int().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    withCompanyDb<{ company: string; asOf?: string; minDays?: number }>(server, ({ db, args }) => {
      const result = buildOverdueInvoiceList(db, { asOfDate: args.asOf, minDays: args.minDays });
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_interest_calc",
    {
      title: "Calculate invoice late interest",
      description: "Beregner morarente uden at registrere. Read-only.",
      inputSchema: {
        ...docIdOrNumberSchema,
        asOf: z.string().min(1),
        referenceRate: z.number(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    withCompanyDb<{
      company: string;
      documentId?: number;
      invoiceNumber?: string;
      asOf: string;
      referenceRate: number;
    }>(server, ({ db, args }) => {
      const id = resolveIssuedInvoiceDocumentId(db, args);
      if (!id) return notFoundEnvelope(args);
      const result = calculateInvoiceLateInterest(db, {
        invoiceDocumentId: id,
        asOfDate: args.asOf,
        referenceRatePercent: args.referenceRate,
      });
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_compensation_calc",
    {
      title: "Calculate invoice late compensation",
      description: "Beregner kompensationskrav for sen betaling uden at registrere. Read-only.",
      inputSchema: {
        ...docIdOrNumberSchema,
        asOf: z.string().min(1),
        amountDkk: z.number().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    withCompanyDb<{
      company: string;
      documentId?: number;
      invoiceNumber?: string;
      asOf: string;
      amountDkk?: number;
    }>(server, ({ db, args }) => {
      const id = resolveIssuedInvoiceDocumentId(db, args);
      if (!id) return notFoundEnvelope(args);
      const result = calculateInvoiceLateCompensation(db, {
        invoiceDocumentId: id,
        asOfDate: args.asOf,
        compensationAmountDkk: args.amountDkk,
      });
      return wrapCoreResult(result);
    }),
  );

  // ------------------------------------------------------- write-irreversible

  server.registerTool(
    "invoice_issue",
    {
      title: "Issue invoice",
      description:
        "Udsteder kundefaktura + immutable snapshot. write-irreversible. " +
        "Alle beløb i payload er i kroner (decimal DKK, 2 decimaler — ikke øre); vatRate er en brøk (0.25 = 25%).",
      inputSchema: {
        company: z.string().min(1),
        payload: invoicePayloadSchema,
        customerId: z.number().int().positive().optional(),
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      payload: InvoicePayload;
      customerId?: number;
      confirm?: boolean;
    }>(server, "invoice_issue", ({ db, args }) => {
      const resolved = resolveInvoiceMasterData(db, args.payload, { customerId: args.customerId });
      if (!resolved.ok) return wrapCoreResult(resolved);
      const result = issueInvoice(db, args.company, resolved.payload);
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_render",
    {
      title: "Render invoice PDF",
      description:
        "Renderer (eller genskaber) deterministisk PDF for udstedt faktura. write-irreversible.",
      inputSchema: { ...docIdOrNumberSchema, confirm: confirmField },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      documentId?: number;
      invoiceNumber?: string;
      confirm?: boolean;
    }>(server, "invoice_render", ({ db, args }) => {
      const id = resolveIssuedInvoiceDocumentId(db, args);
      if (!id) return notFoundEnvelope(args);
      const result = renderIssuedInvoicePdf(db, args.company, { invoiceDocumentId: id });
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_credit_note",
    {
      title: "Issue credit note",
      description:
        "Udsteder kreditnota mod en eksisterende faktura. write-irreversible. " +
        "payload.grossAmount er i kroner (decimal DKK, ikke øre).",
      inputSchema: {
        company: z.string().min(1),
        payload: creditNotePayloadSchema,
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{ company: string; payload: IssueCreditNoteInput; confirm?: boolean }>(
      server,
      "invoice_credit_note",
      ({ db, args }) => {
        const resolved = resolveOriginalInvoice(db, args.payload as Record<string, unknown>);
        const result = issueCreditNote(db, args.company, resolved as IssueCreditNoteInput);
        return wrapCoreResult(result);
      },
    ),
  );

  server.registerTool(
    "invoice_post",
    {
      title: "Post invoice to ledger",
      description: "Bogfører en udstedt faktura i finansen. write-irreversible.",
      inputSchema: { ...docIdOrNumberSchema, confirm: confirmField },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      documentId?: number;
      invoiceNumber?: string;
      confirm?: boolean;
    }>(server, "invoice_post", ({ db, args }) => {
      const id = resolveIssuedInvoiceDocumentId(db, args);
      if (!id) return notFoundEnvelope(args);
      const result = postIssuedInvoiceToLedger(db, { invoiceDocumentId: id });
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_settle_bank",
    {
      title: "Settle invoice from bank",
      description:
        "Matcher en bankbetaling mod en faktura. write-irreversible. " +
        "payload.amount er i kroner (decimal DKK, ikke øre).",
      inputSchema: {
        company: z.string().min(1),
        payload: bankSettlementPayloadSchema,
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      payload: SettleInvoiceFromBankInput & { invoiceNumber?: string };
      confirm?: boolean;
    }>(server, "invoice_settle_bank", ({ db, args }) => {
      const resolved = resolveInvoiceInPayload(db, args.payload as Record<string, unknown>);
      const result = settleInvoiceFromBank(db, resolved as SettleInvoiceFromBankInput);
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_settle_claim_bank",
    {
      title: "Settle invoice claims from bank",
      description:
        "Matcher en bankbetaling mod fakturakrav. write-irreversible. " +
        "payload.amount er i kroner (decimal DKK, ikke øre).",
      inputSchema: {
        company: z.string().min(1),
        payload: bankSettlementPayloadSchema,
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      payload: SettleInvoiceClaimsFromBankInput & { invoiceNumber?: string };
      confirm?: boolean;
    }>(server, "invoice_settle_claim_bank", ({ db, args }) => {
      const resolved = resolveInvoiceInPayload(db, args.payload as Record<string, unknown>);
      const result = settleInvoiceClaimsFromBank(db, resolved as SettleInvoiceClaimsFromBankInput);
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_write_off_bad_debt",
    {
      title: "Write off bad debt",
      description:
        "Bogfører tab på debitor. write-irreversible. " +
        "payload.grossAmount er i kroner (decimal DKK, ikke øre).",
      inputSchema: {
        company: z.string().min(1),
        payload: badDebtPayloadSchema,
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      payload: WriteOffInvoiceBadDebtInput & { invoiceNumber?: string };
      confirm?: boolean;
    }>(server, "invoice_write_off_bad_debt", ({ db, args }) => {
      const resolved = resolveInvoiceInPayload(db, args.payload as Record<string, unknown>);
      const result = writeOffInvoiceBadDebt(db, resolved as WriteOffInvoiceBadDebtInput);
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_apply_payment",
    {
      title: "Apply invoice payment",
      description:
        "Registrerer fakturabetaling fra payload. write-irreversible. " +
        "payload.amount er i kroner (decimal DKK, ikke øre).",
      inputSchema: {
        company: z.string().min(1),
        payload: applyPaymentPayloadSchema,
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      payload: ApplyInvoicePaymentInput & { invoiceNumber?: string };
      confirm?: boolean;
    }>(server, "invoice_apply_payment", ({ db, args }) => {
      const resolved = resolveInvoiceInPayload(db, args.payload as Record<string, unknown>);
      const result = applyInvoicePayment(db, resolved as ApplyInvoicePaymentInput);
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_refund_bank",
    {
      title: "Refund invoice to bank",
      description:
        "Bogfører refundering til kunde fra banken. write-irreversible. " +
        "payload.amount er i kroner (decimal DKK, ikke øre).",
      inputSchema: {
        company: z.string().min(1),
        payload: refundBankPayloadSchema,
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      payload: RefundInvoiceToBankInput & { invoiceNumber?: string };
      confirm?: boolean;
    }>(server, "invoice_refund_bank", ({ db, args }) => {
      const resolved = resolveInvoiceInPayload(db, args.payload as Record<string, unknown>);
      const result = refundInvoiceToBank(db, resolved as RefundInvoiceToBankInput);
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_remind",
    {
      title: "Register invoice reminder",
      description: "Registrerer rykker på forfalden faktura. write-irreversible.",
      inputSchema: {
        ...docIdOrNumberSchema,
        date: z.string().min(1),
        fee: z.number().optional(),
        note: z.string().optional(),
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      documentId?: number;
      invoiceNumber?: string;
      date: string;
      fee?: number;
      note?: string;
      confirm?: boolean;
    }>(server, "invoice_remind", ({ db, args }) => {
      const id = resolveIssuedInvoiceDocumentId(db, args);
      if (!id) return notFoundEnvelope(args);
      const result = registerInvoiceReminder(db, {
        invoiceDocumentId: id,
        reminderDate: args.date,
        feeAmount: args.fee,
        note: args.note,
      });
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_post_reminder",
    {
      title: "Post invoice reminder to ledger",
      description: "Bogfører en registreret rykker. write-irreversible.",
      inputSchema: {
        ...docIdOrNumberSchema,
        reminderId: z.number().int().positive().optional(),
        date: z.string().optional(),
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      documentId?: number;
      invoiceNumber?: string;
      reminderId?: number;
      date?: string;
      confirm?: boolean;
    }>(server, "invoice_post_reminder", ({ db, args }) => {
      const id = resolveIssuedInvoiceDocumentId(db, args);
      if (!id) return notFoundEnvelope(args);
      const result = postInvoiceReminderToLedger(db, {
        invoiceDocumentId: id,
        reminderId: args.reminderId,
        transactionDate: args.date,
      });
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_claim_interest",
    {
      title: "Register late-interest claim",
      description: "Registrerer morarentekrav. write-irreversible.",
      inputSchema: {
        ...docIdOrNumberSchema,
        asOf: z.string().min(1),
        referenceRate: z.number(),
        note: z.string().optional(),
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      documentId?: number;
      invoiceNumber?: string;
      asOf: string;
      referenceRate: number;
      note?: string;
      confirm?: boolean;
    }>(server, "invoice_claim_interest", ({ db, args }) => {
      const id = resolveIssuedInvoiceDocumentId(db, args);
      if (!id) return notFoundEnvelope(args);
      const result = registerInvoiceLateInterest(db, {
        invoiceDocumentId: id,
        asOfDate: args.asOf,
        referenceRatePercent: args.referenceRate,
        note: args.note,
      });
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_post_interest",
    {
      title: "Post late-interest claim to ledger",
      description: "Bogfører registreret morarentekrav. write-irreversible.",
      inputSchema: {
        ...docIdOrNumberSchema,
        claimId: z.number().int().positive().optional(),
        date: z.string().optional(),
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      documentId?: number;
      invoiceNumber?: string;
      claimId?: number;
      date?: string;
      confirm?: boolean;
    }>(server, "invoice_post_interest", ({ db, args }) => {
      const id = resolveIssuedInvoiceDocumentId(db, args);
      if (!id) return notFoundEnvelope(args);
      const result = postInvoiceLateInterestToLedger(db, {
        invoiceDocumentId: id,
        claimId: args.claimId,
        transactionDate: args.date,
      });
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_claim_compensation",
    {
      title: "Register late-compensation claim",
      description: "Registrerer kompensationskrav (uden at bogføre). write-irreversible.",
      inputSchema: {
        ...docIdOrNumberSchema,
        asOf: z.string().min(1),
        amountDkk: z.number().optional(),
        note: z.string().optional(),
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      documentId?: number;
      invoiceNumber?: string;
      asOf: string;
      amountDkk?: number;
      note?: string;
      confirm?: boolean;
    }>(server, "invoice_claim_compensation", ({ db, args }) => {
      const id = resolveIssuedInvoiceDocumentId(db, args);
      if (!id) return notFoundEnvelope(args);
      const result = registerInvoiceLateCompensation(db, {
        invoiceDocumentId: id,
        asOfDate: args.asOf,
        compensationAmountDkk: args.amountDkk,
        note: args.note,
      });
      return wrapCoreResult(result);
    }),
  );

  server.registerTool(
    "invoice_post_compensation",
    {
      title: "Post compensation claim to ledger",
      description: "Bogfører registreret kompensationskrav. write-irreversible.",
      inputSchema: {
        ...docIdOrNumberSchema,
        date: z.string().optional(),
        confirm: confirmField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      documentId?: number;
      invoiceNumber?: string;
      date?: string;
      confirm?: boolean;
    }>(server, "invoice_post_compensation", ({ db, args }) => {
      const id = resolveIssuedInvoiceDocumentId(db, args);
      if (!id) return notFoundEnvelope(args);
      const result = postInvoiceLateCompensationToLedger(db, {
        invoiceDocumentId: id,
        transactionDate: args.date,
      });
      return wrapCoreResult(result);
    }),
  );
}

// Resolve invoice document id inside a payload that may pass invoiceNumber instead.
function resolveInvoiceInPayload(
  db: import("bun:sqlite").Database,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (
    payload.invoiceDocumentId === undefined ||
    payload.invoiceDocumentId === null ||
    payload.invoiceDocumentId === 0
  ) {
    const value = typeof payload.invoiceNumber === "string" ? payload.invoiceNumber.trim() : "";
    if (value) {
      const row = db
        .query(`SELECT id FROM documents WHERE document_type = 'issued_invoice' AND invoice_no = ? LIMIT 1`)
        .get(value) as { id: number } | null;
      if (row) return { ...payload, invoiceDocumentId: row.id };
    }
  }
  return payload;
}

function resolveOriginalInvoice(
  db: import("bun:sqlite").Database,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (
    payload.originalInvoiceDocumentId === undefined ||
    payload.originalInvoiceDocumentId === null ||
    payload.originalInvoiceDocumentId === 0
  ) {
    const value =
      typeof payload.originalInvoiceNumber === "string" ? payload.originalInvoiceNumber.trim() : "";
    if (value) {
      const row = db
        .query(`SELECT id FROM documents WHERE document_type = 'issued_invoice' AND invoice_no = ? LIMIT 1`)
        .get(value) as { id: number } | null;
      if (row) return { ...payload, originalInvoiceDocumentId: row.id };
    }
  }
  return payload;
}
