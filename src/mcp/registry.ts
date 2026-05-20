/**
 * Central tools-registrering for Rentemester-MCP-serveren.
 *
 * Tool-surface (jf. docs/mcp-tool-surface.md):
 *  - read (22):           audit, accounts, bank list/suggest/reconcile,
 *                         customer list/validate-vat, vendor list,
 *                         documents list, exceptions list,
 *                         invoice status/list/find/overdue/interest/compensation/validate,
 *                         journal list, period list, retention status,
 *                         system backup-status/healthcheck, vat report
 *  - write-reversible (5): bank import, customer create, vendor create,
 *                          documents ingest, exception resolve
 *  - write-irreversible (~21): invoice issue/post/render/credit-note/
 *                              settle-bank/settle-claim-bank/write-off-bad-debt/
 *                              apply-payment/refund-bank/remind/post-reminder/
 *                              claim-interest/post-interest/claim-compensation/
 *                              post-compensation; journal post/reverse;
 *                              expense book; vat post-eu-service/post-representation;
 *                              period close; system backup/export-authority
 *  - destructive (1):     system restore-backup
 *
 * Hver `register*Tools(server)`-funktion lever i `src/mcp/tools/<area>.ts`
 * og tilføjer kun sit eget domæne. Det gør tool-surface'en tæt på 1:1 med
 * `src/cli-meta.ts` og holder hver fil overskuelig.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountsTools } from "./tools/accounts";
import { registerAuditTools } from "./tools/audit";
import { registerBankTools } from "./tools/bank";
import { registerCustomerTools } from "./tools/customer";
import { registerDocumentTools } from "./tools/documents";
import { registerExceptionTools } from "./tools/exceptions";
import { registerExpenseTools } from "./tools/expense";
import { registerInvoiceTools } from "./tools/invoice";
import { registerJournalTools } from "./tools/journal";
// PEPPOL submission (#128)
import { registerPeppolTools } from "./tools/peppol";
import { registerPeriodTools } from "./tools/period";
import { registerRetentionTools } from "./tools/retention";
import { registerSystemTools } from "./tools/system";
import { registerVatTools } from "./tools/vat";
import { registerVendorTools } from "./tools/vendor";
// ===== RECURRING INVOICES (#118) =====
import { registerRecurringInvoiceTools } from "./tools/recurring-invoice";
// ===== END RECURRING INVOICES (#118) =====
// ===== MAIL INTAKE (#122) =====
import { registerMailIntakeTools } from "./tools/mail-intake";
// ===== MILEAGE LOG (#123) =====
import { registerMileageTools } from "./tools/mileage";
// Fixed assets (#124, #125)
import { registerAssetTools } from "./tools/asset";
// Multi-company portfolio: company_add + portfolio_overview (#172)
import { registerPortfolioTools } from "./tools/portfolio";
// ===== EMAIL DELIVERY (#180) =====
import { registerEmailTools } from "./tools/email";
// ===== END EMAIL DELIVERY (#180) =====

export function registerAllTools(server: McpServer): void {
  registerAccountsTools(server);
  registerAuditTools(server);
  registerBankTools(server);
  registerCustomerTools(server);
  registerDocumentTools(server);
  registerExceptionTools(server);
  registerExpenseTools(server);
  registerInvoiceTools(server);
  registerJournalTools(server);
  // PEPPOL submission (#128)
  registerPeppolTools(server);
  registerPeriodTools(server);
  registerRetentionTools(server);
  registerSystemTools(server);
  registerVatTools(server);
  registerVendorTools(server);
  // ===== RECURRING INVOICES (#118) =====
  registerRecurringInvoiceTools(server);
  // ===== END RECURRING INVOICES (#118) =====
  // ===== MAIL INTAKE (#122) =====
  registerMailIntakeTools(server);
  // ===== MILEAGE LOG (#123) =====
  registerMileageTools(server);
  // Fixed assets (#124, #125)
  registerAssetTools(server);
  // Multi-company portfolio: company_add + portfolio_overview (#172)
  registerPortfolioTools(server);
  // ===== EMAIL DELIVERY (#180) =====
  registerEmailTools(server);
  // ===== END EMAIL DELIVERY (#180) =====
}
