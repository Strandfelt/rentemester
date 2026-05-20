import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { writeFileAtomic } from "./atomic-file";
import { companyPaths } from "./paths";

/**
 * Workspace model.
 *
 * A *workspace* is a root directory that owns one or more company volumes as
 * subdirectories `<workspace>/<slug>/`. Each subdirectory is an ordinary
 * Rentemester company directory (a `data/ledger.sqlite` plus the usual
 * `companyPaths` subdirs).
 *
 * The company directories are the source of truth: a `workspace.json` manifest
 * in the root is a lightweight index (slug, display name, createdAt, archived).
 * A present-but-unlisted directory can be adopted into the manifest.
 *
 * This module is intentionally pure filesystem + JSON: the later cockpit API
 * (#170) and MCP tools (#172) call these same functions.
 */

export const WORKSPACE_MANIFEST_FILE = "workspace.json";

const MANIFEST_VERSION = 1 as const;

export type WorkspaceCompanyEntry = {
  /** Filesystem-safe identifier; the subdirectory name under the workspace. */
  slug: string;
  /** Human-readable display name. */
  name: string;
  /** ISO-8601 timestamp of when the entry was first registered. */
  createdAt: string;
  /** Soft-deletion flag; archived companies stay on disk. */
  archived: boolean;
};

export type WorkspaceManifest = {
  version: typeof MANIFEST_VERSION;
  companies: WorkspaceCompanyEntry[];
};

/**
 * Derives a deterministic, filesystem-safe slug from a display name.
 * Danish letters are transliterated so a slug never depends on locale.
 */
export function slugifyCompanyName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "oe")
    .replace(/å/g, "aa")
    .replace(/[àáâãä]/g, "a")
    .replace(/[èéêë]/g, "e")
    .replace(/[ìíîï]/g, "i")
    .replace(/[òóôõö]/g, "o")
    .replace(/[ùúûü]/g, "u")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug;
}

/**
 * Validates a slug used as a workspace subdirectory name. A slug must be a
 * single safe path segment — no separators, no traversal, no leading dot.
 */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

function assertValidSlug(slug: string): void {
  if (!isValidSlug(slug)) {
    throw new Error(
      `invalid company slug '${slug}': use lowercase letters, digits and dashes`,
    );
  }
}

function manifestPath(workspaceRoot: string): string {
  return join(workspaceRoot, WORKSPACE_MANIFEST_FILE);
}

/** True when `workspaceRoot` already holds a `workspace.json` manifest. */
export function workspaceExists(workspaceRoot: string): boolean {
  return existsSync(manifestPath(workspaceRoot));
}

/**
 * Resolves and validates a workspace root path. Rejects `..` traversal so the
 * workspace tree cannot be relocated by a malicious value, mirroring the
 * `--company` path guard in `src/cli.ts`.
 */
export function resolveWorkspaceRoot(raw: string): string {
  if (raw.split(/[\\/]+/).includes("..")) {
    throw new Error("workspace root must not contain parent-directory ('..') segments");
  }
  const resolved = resolve(raw);
  if (!isAbsolute(resolved) || resolved.split(sep).includes("..")) {
    throw new Error("workspace root resolved to an unsafe path");
  }
  return resolved;
}

/**
 * Reads and validates the configured workspace root from
 * `RENTEMESTER_WORKSPACE`. Returns null when the env var is unset/empty so
 * callers can fall back to the legacy single-company (`--company <path>`)
 * behaviour. Throws on an unsafe value.
 */
export function resolveConfiguredWorkspaceRoot(): string | null {
  const raw = process.env.RENTEMESTER_WORKSPACE;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return resolveWorkspaceRoot(raw.trim());
}

function emptyManifest(): WorkspaceManifest {
  return { version: MANIFEST_VERSION, companies: [] };
}

function sortedManifest(manifest: WorkspaceManifest): WorkspaceManifest {
  return {
    version: MANIFEST_VERSION,
    companies: [...manifest.companies].sort((a, b) => a.slug.localeCompare(b.slug)),
  };
}

/**
 * Loads the workspace manifest. Returns an empty manifest if none exists yet,
 * so callers can treat a brand-new root uniformly.
 */
export function loadWorkspaceManifest(workspaceRoot: string): WorkspaceManifest {
  const path = manifestPath(workspaceRoot);
  if (!existsSync(path)) return emptyManifest();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`workspace manifest at ${path} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).companies)) {
    throw new Error(`workspace manifest at ${path} is malformed`);
  }
  const companies: WorkspaceCompanyEntry[] = (parsed as any).companies.map((raw: any) => ({
    slug: String(raw.slug),
    name: String(raw.name),
    createdAt: String(raw.createdAt),
    archived: Boolean(raw.archived),
  }));
  return { version: MANIFEST_VERSION, companies };
}

/**
 * Writes the manifest atomically. Entries are sorted by slug and the JSON is
 * pretty-printed so the file round-trips deterministically and diffs cleanly.
 */
export function saveWorkspaceManifest(
  workspaceRoot: string,
  manifest: WorkspaceManifest,
): void {
  mkdirSync(workspaceRoot, { recursive: true });
  const ordered = sortedManifest(manifest);
  writeFileAtomic(manifestPath(workspaceRoot), `${JSON.stringify(ordered, null, 2)}\n`);
}

/** Creates the workspace root directory and an empty manifest if absent. */
export function initWorkspace(workspaceRoot: string): WorkspaceManifest {
  mkdirSync(workspaceRoot, { recursive: true });
  if (workspaceExists(workspaceRoot)) return loadWorkspaceManifest(workspaceRoot);
  const manifest = emptyManifest();
  saveWorkspaceManifest(workspaceRoot, manifest);
  return manifest;
}

/** Lists the company entries recorded in the manifest. */
export function listWorkspaceCompanies(workspaceRoot: string): WorkspaceCompanyEntry[] {
  return loadWorkspaceManifest(workspaceRoot).companies;
}

/** Returns the manifest entry for `slug`, or null if it is not registered. */
export function findWorkspaceCompany(
  workspaceRoot: string,
  slug: string,
): WorkspaceCompanyEntry | null {
  return listWorkspaceCompanies(workspaceRoot).find((c) => c.slug === slug) ?? null;
}

/** The absolute company directory for `slug` (whether or not it exists). */
export function companyRootForSlug(workspaceRoot: string, slug: string): string {
  assertValidSlug(slug);
  return join(workspaceRoot, slug);
}

/**
 * Resolves a workspace slug to its company directory.
 *
 * Returns the absolute path when the slug is registered in the manifest,
 * otherwise null — callers (e.g. `resolveCompanyRoot` in the CLI) decide
 * whether to fall back to treating the value as a raw path.
 */
export function resolveWorkspaceSlug(workspaceRoot: string, slug: string): string | null {
  if (!isValidSlug(slug)) return null;
  if (!findWorkspaceCompany(workspaceRoot, slug)) return null;
  return companyRootForSlug(workspaceRoot, slug);
}

/**
 * Registers a company entry in the manifest. Idempotent if the slug already
 * exists with identical data; throws on a conflicting duplicate.
 */
export function registerWorkspaceCompany(
  workspaceRoot: string,
  entry: WorkspaceCompanyEntry,
): WorkspaceCompanyEntry {
  assertValidSlug(entry.slug);
  const manifest = loadWorkspaceManifest(workspaceRoot);
  if (manifest.companies.some((c) => c.slug === entry.slug)) {
    throw new Error(`company slug '${entry.slug}' is already registered in the workspace`);
  }
  manifest.companies.push(entry);
  saveWorkspaceManifest(workspaceRoot, manifest);
  return entry;
}

/**
 * Adopts a present-but-unlisted company directory into the manifest. The
 * directory must already contain a ledger DB; the company name is read from
 * its `companies` table when available, otherwise defaults to the slug.
 */
export function adoptCompanyDir(
  workspaceRoot: string,
  slug: string,
  options?: { name?: string; createdAt?: string },
): WorkspaceCompanyEntry {
  assertValidSlug(slug);
  if (findWorkspaceCompany(workspaceRoot, slug)) {
    throw new Error(`company slug '${slug}' is already in the workspace manifest`);
  }
  const companyRoot = companyRootForSlug(workspaceRoot, slug);
  const p = companyPaths(companyRoot);
  if (!existsSync(p.db)) {
    throw new Error(
      `cannot adopt '${slug}': no ledger found at ${p.db} — not a company directory`,
    );
  }
  const name = options?.name ?? readCompanyName(p.db) ?? slug;
  return registerWorkspaceCompany(workspaceRoot, {
    slug,
    name,
    createdAt: options?.createdAt ?? new Date().toISOString(),
    archived: false,
  });
}

/**
 * Updates the display name of a registered company in the manifest. The slug
 * (and therefore the on-disk directory + ledger) is never touched — only the
 * human-readable label changes. Throws when the slug is not registered.
 */
export function renameWorkspaceCompany(
  workspaceRoot: string,
  slug: string,
  name: string,
): WorkspaceCompanyEntry {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("company display name must not be empty");
  }
  const manifest = loadWorkspaceManifest(workspaceRoot);
  const entry = manifest.companies.find((c) => c.slug === slug);
  if (!entry) {
    throw new Error(`no company with slug '${slug}' in the workspace`);
  }
  entry.name = trimmed;
  saveWorkspaceManifest(workspaceRoot, manifest);
  return entry;
}

/**
 * Sets the soft-deletion (`archived`) flag of a registered company. Archiving
 * is non-destructive: the company directory and its ledger stay on disk, the
 * entry is only flagged so the cockpit can hide/segregate it. Throws when the
 * slug is not registered.
 */
export function setWorkspaceCompanyArchived(
  workspaceRoot: string,
  slug: string,
  archived: boolean,
): WorkspaceCompanyEntry {
  const manifest = loadWorkspaceManifest(workspaceRoot);
  const entry = manifest.companies.find((c) => c.slug === slug);
  if (!entry) {
    throw new Error(`no company with slug '${slug}' in the workspace`);
  }
  entry.archived = archived;
  saveWorkspaceManifest(workspaceRoot, manifest);
  return entry;
}

function readCompanyName(dbPath: string): string | null {
  try {
    // Lazy import keeps the module dependency-light for callers that only
    // need the pure manifest helpers.
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query("SELECT name FROM companies ORDER BY id ASC LIMIT 1").get() as
        | { name: string }
        | null;
      const name = row?.name?.trim();
      return name && name.length > 0 ? name : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
