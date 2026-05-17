import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { seedAccounts } from "../../src/core/ledger";
import { importBankCsv } from "../../src/core/bank";
import { listExceptions, recordException, resolveOpenExceptionsForBankTransaction, syncUnmatchedBankTransactionExceptions } from "../../src/core/exceptions";

describe("exceptions workflow", () => {
  test("syncs unmatched bank transactions once and resolves them without creating duplicates", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-exceptions-"));
    const company = ensureCompanyDirs(root);
    const db = openDb(company.db);
    migrate(db);
    seedAccounts(db);
    db.run(`INSERT INTO companies (id, name, cvr, fiscal_year_start_month, fiscal_year_label_strategy) VALUES (1, 'Rentemester ApS', 'DK12345678', 1, 'end-year')`);

    const csv = join(root, "bank.csv");
    writeFileSync(csv, "transaction_date,text,amount\n2026-05-18,Customer payment,2500\n");
    const imported = importBankCsv(db, root, csv);
    expect(imported.ok).toBe(true);

    const firstSync = syncUnmatchedBankTransactionExceptions(db);
    const secondSync = syncUnmatchedBankTransactionExceptions(db);
    expect(firstSync.created).toBe(1);
    expect(secondSync.created).toBe(0);

    const before = listExceptions(db, { status: "open" });
    expect(before.count).toBe(1);
    expect(before.rows[0].type).toBe("UNMATCHED_BANK_TRANSACTION");
    expect(before.rows[0].sourceEvidence.bankTransactionId).toBe(1);

    const resolved = resolveOpenExceptionsForBankTransaction(db, 1, "Resolved automatically by test workflow", "agent:test");
    expect(resolved.ok).toBe(true);
    expect(resolved.resolvedCount).toBe(1);

    const after = listExceptions(db, { status: "resolved" });
    expect(after.count).toBe(1);
    expect(after.rows[0].resolutionNote).toContain("Resolved automatically by test workflow");
    expect(after.rows[0].resolvedBy).toBe("agent:test");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("records generic blocked-work exceptions with evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-exception-record-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const inserted = recordException(db, {
      type: "DOCUMENT_INGEST_BLOCKED",
      severity: "medium",
      message: "Document ingest blocked for /tmp/bad.txt",
      requiredAction: "Fix metadata and retry.",
      sourceEvidence: { file: "/tmp/bad.txt", errors: ["sender.name is required"] },
      postingPreview: { retryCommand: "documents ingest --company <path> --file <file> --metadata <file.json>" },
    });
    expect(inserted.ok).toBe(true);

    const resolved = resolveOpenExceptionsForBankTransaction(db, 999);
    expect(resolved.ok).toBe(true);
    expect(resolved.resolvedCount).toBe(0);

    const listed = listExceptions(db, { status: "all" });
    expect(listed.count).toBe(1);
    expect(listed.rows[0].sourceEvidence.errors[0]).toContain("sender.name");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
