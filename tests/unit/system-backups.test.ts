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

  test("takes a locked snapshot so concurrent writes wait and stay out of the backup", async () => {
    const companyRoot = mkdtempSync(join(tmpdir(), "rentemester-backup-lock-"));
    const paths = ensureCompanyDirs(companyRoot);
    const db = openDb(paths.db);
    migrate(db);

    const writerScript = join(companyRoot, "writer.ts");
    writeFileSync(writerScript, `
      await Bun.sleep(50);
      const { openDb } = await import(${JSON.stringify(join(process.cwd(), "src/core/db.ts"))});
      const db = openDb(process.argv[2]);
      const started = Date.now();
      db.run(
        "INSERT INTO bank_transactions (transaction_date, booking_date, text, amount, currency, reference, import_batch_id, source_file_hash, transaction_hash) VALUES (?, ?, ?, ?, 'DKK', ?, ?, ?, ?)",
        "2026-05-17",
        "2026-05-17",
        "Concurrent customer payment",
        500,
        "LOCK-REF-1",
        "batch-lock-1",
        "hash-lock-a",
        "tx-lock-1",
      );
      console.log(String(Date.now() - started));
      db.close();
    `);

    const writer = Bun.spawn(["bun", "run", writerScript, paths.db], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const backup = createSystemBackup(db, companyRoot, { createdAt: "2026-05-17T02:09:00.000Z", debugHoldMs: 400 });
    expect(backup.ok).toBe(true);

    const writerStdout = await new Response(writer.stdout).text();
    const writerStderr = await new Response(writer.stderr).text();
    const writerExit = await writer.exited;
    expect({ writerExit, writerStderr }).toEqual({ writerExit: 0, writerStderr: "" });

    const waitedMs = Number(writerStdout.trim());
    expect(Number.isFinite(waitedMs)).toBe(true);
    expect(waitedMs).toBeGreaterThanOrEqual(250);

    const manifest = JSON.parse(readFileSync(backup.manifestPath!, "utf8"));
    expect(manifest.ledgerStats.bankTransactions).toBe(0);
    const liveCount = (db.query("SELECT COUNT(*) AS n FROM bank_transactions").get() as { n: number }).n;
    expect(liveCount).toBe(1);

    db.close();
    rmSync(companyRoot, { recursive: true, force: true });
  });

  test("treats same-day bank activity as newer than an earlier same-day backup", () => {
    const companyRoot = mkdtempSync(join(tmpdir(), "rentemester-backup-sameday-"));
    const paths = ensureCompanyDirs(companyRoot);
    const db = openDb(paths.db);
    migrate(db);

    const backup = createSystemBackup(db, companyRoot, { createdAt: "2026-05-17T02:09:00.000Z" });
    expect(backup.ok).toBe(true);

    db.run(
      "INSERT INTO bank_transactions (transaction_date, booking_date, text, amount, currency, reference, import_batch_id, source_file_hash, transaction_hash) VALUES (?, ?, ?, ?, 'DKK', ?, ?, ?, ?)",
      "2026-05-17",
      "2026-05-17",
      "Later same-day bank activity",
      500,
      "REF-SAMEDAY-1",
      "batch-sameday-1",
      "hash-sameday-a",
      "tx-sameday-1",
    );

    const status = getBackupComplianceStatus(db, companyRoot, "2026-05-17T03:00:00.000Z");
    expect(status.hasActivitySinceBackup).toBe(true);
    expect(status.latestBackupId).toBe("backup-20260517T020900Z");

    db.close();
    rmSync(companyRoot, { recursive: true, force: true });
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
