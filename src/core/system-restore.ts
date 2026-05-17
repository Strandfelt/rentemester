import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { companyPaths, ensureCompanyDirs } from "./paths";

const RULE_ID = "DK-BOOKKEEPING-RESTORE-001";

type ManifestFile = { path: string; sha256: string; sizeBytes: number };
type BackupManifest = {
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

function ensureMatches(file: ManifestFile) {
  if (!existsSync(file.path)) return `missing backup file: ${file.path}`;
  const actualSize = statSync(file.path).size;
  if (actualSize !== file.sizeBytes) return `size mismatch for ${file.path}`;
  const actualHash = sha256File(file.path);
  if (actualHash !== file.sha256) return `sha256 mismatch for ${file.path}`;
  return null;
}

function companyLooksEmpty(targetCompanyRoot: string) {
  if (!existsSync(targetCompanyRoot)) return true;
  return readdirSync(targetCompanyRoot).length === 0;
}

function restoreFiles(files: ManifestFile[], targetDir: string) {
  mkdirSync(targetDir, { recursive: true });
  for (const file of files) {
    copyFileSync(file.path, join(targetDir, file.path.split("/").at(-1)!));
  }
  return files.length;
}

export function restoreSystemBackup(input: RestoreSystemBackupInput): RestoreSystemBackupResult {
  const errors: string[] = [];
  if (!input.backupDir || !existsSync(input.backupDir)) errors.push(`backupDir does not exist: ${input.backupDir}`);
  if (!input.targetCompanyRoot) errors.push("targetCompanyRoot is required");
  if (errors.length > 0) return { ok: false, appliedRules: [RULE_ID], errors };

  const manifest = readManifest(input.backupDir);
  if (!manifest) return { ok: false, appliedRules: [RULE_ID], errors: [`invalid or missing backup manifest in ${input.backupDir}`] };

  const manifestErrors = [
    ensureMatches(manifest.dbSnapshot),
    ...manifest.copiedFiles.documentsOriginals.map(ensureMatches),
    ...manifest.copiedFiles.invoicesIssued.map(ensureMatches),
    ...manifest.copiedFiles.config.map(ensureMatches),
  ].filter((value): value is string => Boolean(value));
  if (manifestErrors.length > 0) return { ok: false, appliedRules: [RULE_ID], errors: manifestErrors };

  if (!companyLooksEmpty(input.targetCompanyRoot)) {
    return { ok: false, appliedRules: [RULE_ID], errors: [`targetCompanyRoot must be empty or absent: ${input.targetCompanyRoot}`] };
  }

  const paths = ensureCompanyDirs(input.targetCompanyRoot);
  copyFileSync(manifest.dbSnapshot.path, paths.db);
  const restoredFiles = {
    documentsOriginals: restoreFiles(manifest.copiedFiles.documentsOriginals, paths.documentsOriginals),
    invoicesIssued: restoreFiles(manifest.copiedFiles.invoicesIssued, paths.invoicesIssued),
    config: restoreFiles(manifest.copiedFiles.config, paths.config),
  };

  return {
    ok: true,
    backupId: manifest.backupId,
    restoredAt: new Date().toISOString(),
    targetCompanyRoot: input.targetCompanyRoot,
    restoredDbPath: companyPaths(input.targetCompanyRoot).db,
    restoredFiles,
    appliedRules: [RULE_ID],
    errors: [],
  };
}
