import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { seedAccounts } from "../../src/core/ledger";
import { issueInvoice } from "../../src/core/issued-invoices";
import { ingestDocument } from "../../src/core/documents";
import { importBankCsv } from "../../src/core/bank";

function invoicePayload(overrides: Record<string, unknown> = {}) {
  return {
    invoiceType: "full",
    vatTreatment: "standard",
    issueDate: "2026-05-16",
    invoiceNumber: "2026-0001",
    seller: {
      name: "Rentemester ApS",
      address: "Testvej 1, 2100 København Ø",
      vatOrCvr: "DK12345678",
    },
    buyer: {
      name: "Kunde A/S",
      address: "Købervej 9, 8000 Aarhus C",
      vatOrCvr: "DK87654321",
    },
    lines: [
      {
        description: "Bogføring og momsafstemning",
        quantity: 1,
        unitPriceExVat: 1000,
        lineTotalExVat: 1000,
      },
    ],
    totals: {
      netAmount: 1000,
      vatRate: 0.25,
      vatAmount: 250,
      grossAmount: 1250,
    },
    currency: "DKK",
    dueDate: "2026-06-15",
    ...overrides,
  };
}

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("bank suggest-matches CLI", () => {
  test("suggests issued-invoice and purchase-sale matches for unmatched bank transactions", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-suggest-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-bank-suggest-inbox-"));
    const paths = ensureCompanyDirs(root);
    const db = openDb(paths.db);
    migrate(db);
    seedAccounts(db);

    const invoice = issueInvoice(db, root, invoicePayload());
    expect(invoice.ok).toBe(true);

    const sourceFile = join(inbox, "vendor.txt");
    writeFileSync(sourceFile, "Software invoice\n1250 DKK\n");
    const purchase = ingestDocument(db, root, sourceFile, {
      source: "email",
      issueDate: "2026-05-16",
      invoiceNo: "SUP-1001",
      deliveryDescription: "Software subscription",
      amountIncVat: 1250,
      currency: "DKK",
      sender: { name: "Stripe Payments Ltd", address: "1 Market St", vatOrCvr: "DK11223344" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 250,
      paymentDetails: "Stripe payout",
    });
    expect(purchase.ok).toBe(true);

    const csv = join(root, "transactions.csv");
    writeFileSync(csv, [
      "transaction_date,booking_date,text,amount,currency,reference",
      "2026-05-20,2026-05-20,Customer payment 2026-0001 Kunde A/S,1250,DKK,INV-2026-0001",
      "2026-05-16,2026-05-16,Stripe payout SUP-1001,-1250,DKK,STRIPE-1",
    ].join("\n"));
    const imported = importBankCsv(db, root, csv);
    expect(imported.ok).toBe(true);

    const invoiceBank = db.query("SELECT id FROM bank_transactions WHERE reference = 'INV-2026-0001'").get() as { id: number };
    db.close();

    const listed = await runCli(["bank", "suggest-matches", "--company", root, "--format", "json"]);
    const filtered = await runCli(["bank", "suggest-matches", "--company", root, "--bank-transaction-id", String(invoiceBank.id), "--max", "1", "--format", "json"]);

    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });

    expect(listed.exitCode).toBe(0);
    expect(listed.stderr).toBe("");
    const listedJson = JSON.parse(listed.stdout);
    expect(listedJson.count).toBe(2);

    const invoiceRow = listedJson.rows.find((row: any) => row.reference === "INV-2026-0001");
    expect(invoiceRow.suggestions[0]).toMatchObject({
      kind: "issued_invoice",
      invoiceNo: "2026-0001",
      customerName: "Kunde A/S",
    });
    expect(invoiceRow.suggestions[0].reasons.some((reason: string) => reason.includes("amount match"))).toBe(true);

    const purchaseRow = listedJson.rows.find((row: any) => row.reference === "STRIPE-1");
    expect(purchaseRow.suggestions[0]).toMatchObject({
      kind: "purchase_sale",
      invoiceNo: "SUP-1001",
      supplierName: "Stripe Payments Ltd",
    });
    expect(purchaseRow.suggestions[0].reasons.some((reason: string) => reason.includes("supplier token match"))).toBe(true);

    expect(filtered.exitCode).toBe(0);
    expect(filtered.stderr).toBe("");
    const filteredJson = JSON.parse(filtered.stdout);
    expect(filteredJson.count).toBe(1);
    expect(filteredJson.rows[0].bankTransactionId).toBe(invoiceBank.id);
    expect(filteredJson.rows[0].suggestions).toHaveLength(1);
    expect(filteredJson.rows[0].suggestions[0].invoiceNo).toBe("2026-0001");
  });
});
