import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { ingestDocument } from "../../src/core/documents";
import { createSystemBackup, getBackupComplianceStatus } from "../../src/core/system-backups";

describe("system backups", () => {
  test("creates a full backup snapshot with manifest and copied documents", () => {
    const companyRoot = mkdtempSync(join(tmpdir(), "rentemester-backup-"));
    const inboxRoot = mkdtempSync(join(tmpdir(), "rentemester-backup-inbox-"));
    const sourceFile = join(inboxRoot, "vendor-invoice.txt");
    writeFileSync(sourceFile, "Invoice 1001\nAmount 1250 DKK\n");

    const paths = ensureCompanyDirs(companyRoot);
    const db = openDb(paths.db);
    migrate(db);
    ingestDocument(db, companyRoot, sourceFile, {
      source: "email",
      issueDate: "2026-05-16",
      invoiceNo: "INV-1001",
      deliveryDescription: "Bogføring og momsafstemning",
      amountIncVat: 1250,
      currency: "DKK",
      sender: { name: "Leverandør ApS", address: "Sælgervej 1", vatOrCvr: "DK11223344" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 250,
      paymentDetails: "Bankoverførsel",
    });

    const result = createSystemBackup(db, companyRoot, { createdAt: "2026-05-17T02:09:00.000Z" });
    expect(result.ok).toBe(true);
    expect(existsSync(result.dbSnapshotPath!)).toBe(true);
    expect(existsSync(result.manifestPath!)).toBe(true);

    const manifest = JSON.parse(readFileSync(result.manifestPath!, "utf8"));
    expect(manifest.backupId).toBe("backup-20260517T020900Z");
    expect(manifest.dbSnapshot.path).toBe("ledger.sqlite");
    expect(manifest.copiedFiles.documentsOriginals[0].path).toStartWith("documents-originals/");
    expect(manifest.copiedFiles.documentsOriginals.length).toBe(1);
    expect(manifest.ledgerStats.documents).toBe(1);

    db.close();
    rmSync(companyRoot, { recursive: true, force: true });
    rmSync(inboxRoot, { recursive: true, force: true });
  });

  test("flags weekly backup duty when activity exists after an old backup", () => {
    const companyRoot = mkdtempSync(join(tmpdir(), "rentemester-backup-due-"));
    const paths = ensureCompanyDirs(companyRoot);
    const db = openDb(paths.db);
    migrate(db);

    db.run(
      "INSERT INTO bank_transactions (transaction_date, booking_date, text, amount, currency, reference, import_batch_id, source_file_hash, transaction_hash) VALUES (?, ?, ?, ?, 'DKK', ?, ?, ?, ?)",
      "2026-05-16",
      "2026-05-16",
      "Customer payment",
      1250,
      "REF-1",
      "batch-1",
      "hash-a",
      "tx-1",
    );

    const oldBackupAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const statusCheckAt = new Date().toISOString();
    const backup = createSystemBackup(db, companyRoot, { createdAt: oldBackupAt });
    expect(backup.ok).toBe(true);

    db.run(
      "INSERT INTO bank_transactions (transaction_date, booking_date, text, amount, currency, reference, import_batch_id, source_file_hash, transaction_hash) VALUES (?, ?, ?, ?, 'DKK', ?, ?, ?, ?)",
      "2026-05-17",
      "2026-05-17",
      "Late customer payment",
      500,
      "REF-2",
      "batch-2",
      "hash-b",
      "tx-2",
    );

    const status = getBackupComplianceStatus(db, companyRoot, statusCheckAt);
    expect(status.ok).toBe(false);
    expect(status.backupDue).toBe(true);
    expect(status.hasActivitySinceBackup).toBe(true);
    expect(status.appliedRules).toContain("DK-BOOKKEEPING-BACKUP-001");

    db.close();
    rmSync(companyRoot, { recursive: true, force: true });
  });
});
