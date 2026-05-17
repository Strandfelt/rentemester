import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { seedAccounts, postJournalEntry } from "../../src/core/ledger";
import { ingestDocument } from "../../src/core/documents";
import { createSystemBackup } from "../../src/core/system-backups";
import { restoreSystemBackup } from "../../src/core/system-restore";

function sha256File(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("system restore", () => {
  test("restores a moved backup into a fresh company root and records a restore audit event", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-restore-"));
    const companyRoot = join(root, "company");
    const movedBackupsRoot = join(root, "moved-backups");
    const restoredRoot = join(root, "restored-company");
    const paths = ensureCompanyDirs(companyRoot);
    const db = openDb(paths.db);
    migrate(db);
    seedAccounts(db);

    const ingested = ingestDocument(db, companyRoot, join(process.cwd(), "examples/vendor-invoice.txt"), JSON.parse(readFileSync(join(process.cwd(), "examples/vendor-invoice.metadata.json"), "utf8")));
    expect(ingested.ok).toBe(true);
    const journal = postJournalEntry(db, JSON.parse(readFileSync(join(process.cwd(), "examples/journal-entry.expense.json"), "utf8")));
    expect(journal.ok).toBe(true);

    const backup = createSystemBackup(db, companyRoot, { createdAt: "2026-05-17T02:39:00.000Z" });
    expect(backup.ok).toBe(true);
    db.close();

    mkdirSync(movedBackupsRoot, { recursive: true });
    const movedBackupDir = join(movedBackupsRoot, "portable-backup");
    renameSync(backup.backupDir!, movedBackupDir);

    const restored = restoreSystemBackup({ backupDir: movedBackupDir, targetCompanyRoot: restoredRoot });
    expect(restored.ok).toBe(true);
    expect(existsSync(restored.restoredDbPath!)).toBe(true);
    expect(restored.restoredFiles?.documentsOriginals).toBe(1);

    const restoredDb = openDb(join(restoredRoot, "data", "ledger.sqlite"));
    migrate(restoredDb);
    const documentCount = (restoredDb.query("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
    const journalCount = (restoredDb.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }).n;
    const restoreEvent = restoredDb.query(
      "SELECT event_type, actor, message FROM audit_log WHERE event_type = 'system_restore' ORDER BY id DESC LIMIT 1"
    ).get() as { event_type: string; actor: string | null; message: string } | null;
    restoredDb.close();

    expect(documentCount).toBe(1);
    expect(journalCount).toBe(1);
    expect(restoreEvent?.event_type).toBe("system_restore");
    expect(restoreEvent?.actor).toBe("system");
    expect(restoreEvent?.message).toContain("backup-20260517T023900Z");

    rmSync(root, { recursive: true, force: true });
  });

  test("rejects a manifest path that escapes the backup directory", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-restore-escape-"));
    const companyRoot = join(root, "company");
    const restoredRoot = join(root, "restored-company");
    const outsideRoot = join(root, "outside");
    const paths = ensureCompanyDirs(companyRoot);
    const db = openDb(paths.db);
    migrate(db);
    seedAccounts(db);

    const ingested = ingestDocument(db, companyRoot, join(process.cwd(), "examples/vendor-invoice.txt"), JSON.parse(readFileSync(join(process.cwd(), "examples/vendor-invoice.metadata.json"), "utf8")));
    expect(ingested.ok).toBe(true);

    const backup = createSystemBackup(db, companyRoot, { createdAt: "2026-05-17T02:39:00.000Z" });
    expect(backup.ok).toBe(true);
    db.close();

    mkdirSync(outsideRoot, { recursive: true });
    const outsideDb = join(outsideRoot, "ledger.sqlite");
    copyFileSync(join(backup.backupDir!, "ledger.sqlite"), outsideDb);

    const manifestPath = join(backup.backupDir!, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dbSnapshot.path = outsideDb;
    manifest.dbSnapshot.sha256 = sha256File(outsideDb);
    manifest.dbSnapshot.sizeBytes = readFileSync(outsideDb).byteLength;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const restored = restoreSystemBackup({ backupDir: backup.backupDir!, targetCompanyRoot: restoredRoot });
    expect(restored.ok).toBe(false);
    expect(restored.errors[0]).toContain("manifest path escapes backup dir");

    rmSync(root, { recursive: true, force: true });
  });

  test("rejects a backup whose snapshot passes file hash checks but fails audit validation", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-restore-auditfail-"));
    const companyRoot = join(root, "company");
    const restoredRoot = join(root, "restored-company");
    const paths = ensureCompanyDirs(companyRoot);
    const db = openDb(paths.db);
    migrate(db);
    seedAccounts(db);

    const ingested = ingestDocument(db, companyRoot, join(process.cwd(), "examples/vendor-invoice.txt"), JSON.parse(readFileSync(join(process.cwd(), "examples/vendor-invoice.metadata.json"), "utf8")));
    expect(ingested.ok).toBe(true);
    const journal = postJournalEntry(db, JSON.parse(readFileSync(join(process.cwd(), "examples/journal-entry.expense.json"), "utf8")));
    expect(journal.ok).toBe(true);

    const backup = createSystemBackup(db, companyRoot, { createdAt: "2026-05-17T02:39:00.000Z" });
    expect(backup.ok).toBe(true);
    db.close();

    const snapshotDb = openDb(join(backup.backupDir!, "ledger.sqlite"));
    snapshotDb.exec("PRAGMA foreign_keys = OFF");
    snapshotDb.exec("DROP TRIGGER IF EXISTS journal_entries_no_update");
    snapshotDb.run("UPDATE journal_entries SET previous_hash = 'BROKEN' WHERE id = 1");
    snapshotDb.close();

    const manifestPath = join(backup.backupDir!, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dbSnapshot.sha256 = sha256File(join(backup.backupDir!, "ledger.sqlite"));
    manifest.dbSnapshot.sizeBytes = readFileSync(join(backup.backupDir!, "ledger.sqlite")).byteLength;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const restored = restoreSystemBackup({ backupDir: backup.backupDir!, targetCompanyRoot: restoredRoot });
    expect(restored.ok).toBe(false);
    expect(restored.errors[0]).toContain("broken audit chain");

    rmSync(root, { recursive: true, force: true });
  });
});
