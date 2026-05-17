import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { seedAccounts, postJournalEntry } from "../../src/core/ledger";
import { ingestDocument } from "../../src/core/documents";
import { createSystemBackup } from "../../src/core/system-backups";
import { restoreSystemBackup } from "../../src/core/system-restore";

describe("system restore", () => {
  test("restores a backup into a fresh company root", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-restore-"));
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

    const restored = restoreSystemBackup({ backupDir: backup.backupDir!, targetCompanyRoot: restoredRoot });
    expect(restored.ok).toBe(true);
    expect(existsSync(restored.restoredDbPath!)).toBe(true);
    expect(restored.restoredFiles?.documentsOriginals).toBe(1);

    const restoredDb = openDb(join(restoredRoot, "data", "ledger.sqlite"));
    migrate(restoredDb);
    const documentCount = (restoredDb.query("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
    const journalCount = (restoredDb.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }).n;
    restoredDb.close();

    expect(documentCount).toBe(1);
    expect(journalCount).toBe(1);

    rmSync(root, { recursive: true, force: true });
  });
});
