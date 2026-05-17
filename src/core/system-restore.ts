import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";
import { createHash } from "node:crypto";
import { openDb } from "./db";
import { verifyAuditChain } from "./ledger";
import { companyPaths, ensureCompanyDirs } from "./paths";
import type { BackupManifest, ManifestFile } from "./system-backups";

const RULE_ID = "DK-BOOKKEEPING-RESTORE-001";

export type RestoreSystemBackupInput = {
  backupDir: string;
  targetCompanyRoot: string;
};

export type RestoreSystemBackupResult = {
  ok: boolean;
  backupId?: string;
  restoredAt?: string;
  targetCompanyRoot?: string;
  restoredDbPath?: string;
  restoredFiles?: {
    documentsOriginals: number;
    invoicesIssued: number;
    config: number;
  };
  appliedRules: string[];
  errors: string[];
};

function sha256File(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readManifest(backupDir: string): BackupManifest | null {
  const manifestPath = join(backupDir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  } catch {
    return null;
  }
}

function resolveManifestPath(backupDir: string, manifestPath: string) {
  const resolvedBackupDir = resolve(backupDir);
  const candidate = isAbsolute(manifestPath) ? resolve(manifestPath) : resolve(resolvedBackupDir, manifestPath);
  const normalizedRoot = `${resolvedBackupDir}${resolvedBackupDir.endsWith("/") ? "" : "/"}`;
  const normalizedCandidate = normalize(candidate);
  if (normalizedCandidate !== resolvedBackupDir && !normalizedCandidate.startsWith(normalizedRoot)) return null;
  return normalizedCandidate;
}

function ensureMatches(backupDir: string, file: ManifestFile) {
  const resolvedPath = resolveManifestPath(backupDir, file.path);
  if (!resolvedPath) return `manifest path escapes backup dir: ${file.path}`;
  if (!existsSync(resolvedPath)) return `missing backup file: ${file.path}`;
  const actualSize = statSync(resolvedPath).size;
  if (actualSize !== file.sizeBytes) return `size mismatch for ${file.path}`;
  const actualHash = sha256File(resolvedPath);
  if (actualHash !== file.sha256) return `sha256 mismatch for ${file.path}`;
  return null;
}

function companyLooksEmpty(targetCompanyRoot: string) {
  if (!existsSync(targetCompanyRoot)) return true;
  return readdirSync(targetCompanyRoot).length === 0;
}

function restoreFiles(backupDir: string, files: ManifestFile[], targetDir: string) {
  mkdirSync(targetDir, { recursive: true });
  for (const file of files) {
    const sourcePath = resolveManifestPath(backupDir, file.path);
    if (!sourcePath) throw new Error(`manifest path escapes backup dir: ${file.path}`);
    copyFileSync(sourcePath, join(targetDir, basename(sourcePath)));
  }
  return files.length;
}

function validateRestoredDb(dbPath: string, manifest: BackupManifest) {
  const db = openDb(dbPath);
  try {
    const integrity = db.query("PRAGMA integrity_check").all() as Array<{ integrity_check?: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      return { ok: false, error: `restored database failed integrity check: ${JSON.stringify(integrity)}` };
    }

    const fkErrors = db.query("PRAGMA foreign_key_check").all() as any[];
    if (fkErrors.length > 0) {
      return { ok: false, error: `restored database has FK violations: ${JSON.stringify(fkErrors)}` };
    }

    const audit = verifyAuditChain(db);
    if (!audit.ok) {
      return { ok: false, error: `restored database has broken audit chain: ${audit.errors.join(", ")}` };
    }

    const stats = {
      journalEntries: (db.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }).n,
      documents: (db.query("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n,
      bankTransactions: (db.query("SELECT COUNT(*) AS n FROM bank_transactions").get() as { n: number }).n,
    };
    if (JSON.stringify(stats) !== JSON.stringify(manifest.ledgerStats)) {
      return { ok: false, error: `restored stats ${JSON.stringify(stats)} differ from manifest ${JSON.stringify(manifest.ledgerStats)}` };
    }

    return { ok: true as const };
  } finally {
    db.close();
  }
}

export function restoreSystemBackup(input: RestoreSystemBackupInput): RestoreSystemBackupResult {
  const errors: string[] = [];
  if (!input.backupDir || !existsSync(input.backupDir)) errors.push(`backupDir does not exist: ${input.backupDir}`);
  if (!input.targetCompanyRoot) errors.push("targetCompanyRoot is required");
  if (errors.length > 0) return { ok: false, appliedRules: [RULE_ID], errors };

  const manifest = readManifest(input.backupDir);
  if (!manifest) return { ok: false, appliedRules: [RULE_ID], errors: [`invalid or missing backup manifest in ${input.backupDir}`] };

  const manifestErrors = [
    ensureMatches(input.backupDir, manifest.dbSnapshot),
    ...manifest.copiedFiles.documentsOriginals.map((file) => ensureMatches(input.backupDir, file)),
    ...manifest.copiedFiles.invoicesIssued.map((file) => ensureMatches(input.backupDir, file)),
    ...manifest.copiedFiles.config.map((file) => ensureMatches(input.backupDir, file)),
  ].filter((value): value is string => Boolean(value));
  if (manifestErrors.length > 0) return { ok: false, appliedRules: [RULE_ID], errors: manifestErrors };

  if (!companyLooksEmpty(input.targetCompanyRoot)) {
    return { ok: false, appliedRules: [RULE_ID], errors: [`targetCompanyRoot must be empty or absent: ${input.targetCompanyRoot}`] };
  }

  const paths = ensureCompanyDirs(input.targetCompanyRoot);
  const snapshotPath = resolveManifestPath(input.backupDir, manifest.dbSnapshot.path);
  if (!snapshotPath) {
    return { ok: false, appliedRules: [RULE_ID], errors: [`manifest path escapes backup dir: ${manifest.dbSnapshot.path}`] };
  }

  copyFileSync(snapshotPath, paths.db);
  const restoredFiles = {
    documentsOriginals: restoreFiles(input.backupDir, manifest.copiedFiles.documentsOriginals, paths.documentsOriginals),
    invoicesIssued: restoreFiles(input.backupDir, manifest.copiedFiles.invoicesIssued, paths.invoicesIssued),
    config: restoreFiles(input.backupDir, manifest.copiedFiles.config, paths.config),
  };

  const restoredAt = new Date().toISOString();
  const validation = validateRestoredDb(paths.db, manifest);
  if (!validation.ok) {
    return { ok: false, appliedRules: [RULE_ID], errors: [validation.error] };
  }

  const db = openDb(paths.db);
  try {
    db.run(
      "INSERT INTO audit_log (event_type, entity_type, entity_id, message, actor) VALUES ('system_restore', 'company', '1', ?, 'system')",
      `Restored from backup ${manifest.backupId} (created ${manifest.createdAt}) at ${restoredAt}`,
    );
  } finally {
    db.close();
  }

  return {
    ok: true,
    backupId: manifest.backupId,
    restoredAt,
    targetCompanyRoot: input.targetCompanyRoot,
    restoredDbPath: companyPaths(input.targetCompanyRoot).db,
    restoredFiles,
    appliedRules: [RULE_ID],
    errors: [],
  };
}
