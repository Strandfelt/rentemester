import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { companyPaths } from "./paths";

const BACKUP_RULE_ID = "DK-BOOKKEEPING-BACKUP-001";
const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export type CreateSystemBackupInput = {
  createdAt?: string;
};

export type CreateSystemBackupResult = {
  ok: boolean;
  backupId?: string;
  backupDir?: string;
  manifestPath?: string;
  dbSnapshotPath?: string;
  appliedRules: string[];
  errors: string[];
};

export type BackupComplianceStatus = {
  ok: boolean;
  appliedRules: string[];
  latestBackupAt: string | null;
  latestBackupId: string | null;
  backupDue: boolean;
  hasActivitySinceBackup: boolean;
  daysSinceLatestBackup: number | null;
  requiredBy: string | null;
  checkedAt: string;
  backupsFound: number;
  evidence: {
    latestJournalEntryAt: string | null;
    latestDocumentAt: string | null;
    latestBankImportAt: string | null;
  };
  errors: string[];
};

export type ManifestFile = { path: string; sha256: string; sizeBytes: number };

export type BackupManifest = {
  backupId: string;
  createdAt: string;
  ruleIds: string[];
  dbSnapshot: ManifestFile;
  copiedFiles: {
    documentsOriginals: ManifestFile[];
    invoicesIssued: ManifestFile[];
    config: ManifestFile[];
  };
  ledgerStats: {
    journalEntries: number;
    documents: number;
    bankTransactions: number;
  };
};

function sha256File(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function relativeBackupPath(backupDir: string, filePath: string) {
  return relative(backupDir, filePath).replaceAll("\\", "/");
}

function copyDirWithManifest(sourceDir: string, targetDir: string, backupDir: string) {
  const copied: ManifestFile[] = [];
  if (!existsSync(sourceDir)) return copied;
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    copyFileSync(sourcePath, targetPath);
    const stats = statSync(targetPath);
    copied.push({ path: relativeBackupPath(backupDir, targetPath), sha256: sha256File(targetPath), sizeBytes: stats.size });
  }
  return copied.sort((a, b) => a.path.localeCompare(b.path));
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function resolveCreatedAt(value?: string) {
  const createdAt = value ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(createdAt))) return null;
  return new Date(createdAt).toISOString();
}

function backupIdFromIso(iso: string) {
  return `backup-${iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

function readBackupManifest(path: string): BackupManifest | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BackupManifest;
  } catch {
    return null;
  }
}

function listBackupManifests(companyRoot: string) {
  const p = companyPaths(companyRoot);
  if (!existsSync(p.backups)) return [] as BackupManifest[];
  return readdirSync(p.backups, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readBackupManifest(join(p.backups, entry.name, "manifest.json")))
    .filter((manifest): manifest is BackupManifest => Boolean(manifest))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function latestActivityTimestamps(db: Database) {
  const latestJournalEntryAt = (db.query("SELECT MAX(registration_datetime) AS value FROM journal_entries").get() as { value: string | null }).value;
  const latestDocumentAt = (db.query("SELECT MAX(upload_datetime) AS value FROM documents").get() as { value: string | null }).value;
  const latestBankImportAt = (db.query("SELECT MAX(COALESCE(booking_date, transaction_date)) AS value FROM bank_transactions").get() as { value: string | null }).value;
  return { latestJournalEntryAt, latestDocumentAt, latestBankImportAt };
}

export function createSystemBackup(db: Database, companyRoot: string, input: CreateSystemBackupInput = {}): CreateSystemBackupResult {
  const createdAt = resolveCreatedAt(input.createdAt);
  if (!createdAt) return { ok: false, appliedRules: [BACKUP_RULE_ID], errors: ["createdAt must be a valid ISO-8601 datetime when provided"] };

  const paths = companyPaths(companyRoot);
  mkdirSync(paths.backups, { recursive: true });
  const backupId = backupIdFromIso(createdAt);
  const backupDir = join(paths.backups, backupId);
  if (existsSync(backupDir)) {
    return { ok: false, appliedRules: [BACKUP_RULE_ID], errors: [`backup already exists: ${backupId}`] };
  }

  mkdirSync(backupDir, { recursive: true });
  const dbSnapshotPath = join(backupDir, "ledger.sqlite");
  const documentsBackupDir = join(backupDir, "documents-originals");
  const invoicesBackupDir = join(backupDir, "invoices-issued");
  const configBackupDir = join(backupDir, "config");

  db.exec("PRAGMA wal_checkpoint(FULL);");
  db.exec(`VACUUM INTO ${sqlString(dbSnapshotPath)}`);

  const snapshotDb = new Database(dbSnapshotPath, { readonly: true });
  const ledgerStats = {
    journalEntries: (snapshotDb.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }).n,
    documents: (snapshotDb.query("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n,
    bankTransactions: (snapshotDb.query("SELECT COUNT(*) AS n FROM bank_transactions").get() as { n: number }).n,
  };
  snapshotDb.close();

  const manifest: BackupManifest = {
    backupId,
    createdAt,
    ruleIds: [BACKUP_RULE_ID],
    dbSnapshot: {
      path: relativeBackupPath(backupDir, dbSnapshotPath),
      sha256: sha256File(dbSnapshotPath),
      sizeBytes: statSync(dbSnapshotPath).size,
    },
    copiedFiles: {
      documentsOriginals: copyDirWithManifest(paths.documentsOriginals, documentsBackupDir, backupDir),
      invoicesIssued: copyDirWithManifest(paths.invoicesIssued, invoicesBackupDir, backupDir),
      config: copyDirWithManifest(paths.config, configBackupDir, backupDir),
    },
    ledgerStats,
  };

  const manifestPath = join(backupDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  db.run(
    "INSERT INTO audit_log (event_type, entity_type, entity_id, message, actor) VALUES ('system_backup', 'company', '1', ?, 'system')",
    `Created full backup ${backupId}`,
  );

  return { ok: true, backupId, backupDir, manifestPath, dbSnapshotPath, appliedRules: [BACKUP_RULE_ID], errors: [] };
}

export function getBackupComplianceStatus(db: Database, companyRoot: string, asOf?: string): BackupComplianceStatus {
  const checkedAt = resolveCreatedAt(asOf);
  if (!checkedAt) {
    return {
      ok: false,
      appliedRules: [BACKUP_RULE_ID],
      latestBackupAt: null,
      latestBackupId: null,
      backupDue: false,
      hasActivitySinceBackup: false,
      daysSinceLatestBackup: null,
      requiredBy: null,
      checkedAt: asOf ?? "",
      backupsFound: 0,
      evidence: { latestJournalEntryAt: null, latestDocumentAt: null, latestBankImportAt: null },
      errors: ["asOf must be a valid ISO-8601 datetime when provided"],
    };
  }

  const manifests = listBackupManifests(companyRoot);
  const latest = manifests.at(-1) ?? null;
  const evidence = latestActivityTimestamps(db);
  const latestBackupAt = latest?.createdAt ?? null;
  const latestBackupId = latest?.backupId ?? null;

  const activityMoments = [evidence.latestJournalEntryAt, evidence.latestDocumentAt, evidence.latestBankImportAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));

  const latestBackupMs = latestBackupAt ? new Date(latestBackupAt).getTime() : null;
  const checkedAtMs = new Date(checkedAt).getTime();
  const latestActivityMs = activityMoments.length > 0 ? Math.max(...activityMoments) : null;
  const hasActivitySinceBackup = latestBackupMs === null ? activityMoments.length > 0 : latestActivityMs !== null && latestActivityMs > latestBackupMs;
  const daysSinceLatestBackup = latestBackupMs === null ? null : Number(((checkedAtMs - latestBackupMs) / (24 * 60 * 60 * 1000)).toFixed(2));
  const backupDue = latestBackupMs === null ? hasActivitySinceBackup : hasActivitySinceBackup && (checkedAtMs - latestBackupMs > BACKUP_INTERVAL_MS);
  const requiredBy = latestBackupMs === null ? (hasActivitySinceBackup ? checkedAt : null) : hasActivitySinceBackup ? new Date(latestBackupMs + BACKUP_INTERVAL_MS).toISOString() : null;

  return {
    ok: !backupDue,
    appliedRules: [BACKUP_RULE_ID],
    latestBackupAt,
    latestBackupId,
    backupDue,
    hasActivitySinceBackup,
    daysSinceLatestBackup,
    requiredBy,
    checkedAt,
    backupsFound: manifests.length,
    evidence,
    errors: [],
  };
}
