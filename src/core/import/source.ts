// Import framework — multi-file export resolution. Issue #192.
//
// A real accounting-system export is not a single file. A Dinero export is a
// directory tree (`Firmaoplysninger.csv` and a per-fiscal-year `Kontoplan.csv`,
// `Posteringer.csv`, ...). `resolveSource` walks an export directory into a
// `MultiArtifactSource` — every file keyed by its export-root-relative,
// forward-slash name, with a BOM-stripped UTF-8 text decode and the raw bytes.
//
// The resolution is DETERMINISTIC: directory entries are read in sorted order
// so the resulting `files` map and any derived ordering is reproducible.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ImportArtifact, MultiArtifactSource } from "./types";

/** Strips a leading UTF-8 BOM (U+FEFF) from a decoded string. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Recursively collects every file under `dir`, keyed by its path relative to
 * `rootDir` using forward slashes. Directory entries are visited in sorted
 * order so the walk is deterministic regardless of filesystem ordering.
 */
function collect(rootDir: string, dir: string, into: Record<string, ImportArtifact>): void {
  const entries = readdirSync(dir).sort();
  for (const entry of entries) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      collect(rootDir, abs, into);
      continue;
    }
    if (!stat.isFile()) continue;
    const rel = abs.slice(rootDir.length).replace(/^[/\\]/, "").split(/[/\\]/).join("/");
    const bytes = new Uint8Array(readFileSync(abs));
    into[rel] = {
      name: rel,
      path: abs,
      bytes,
      text: stripBom(new TextDecoder("utf-8").decode(bytes)),
    };
  }
}

/**
 * Resolves an export `path` into a `MultiArtifactSource`. `path` may point at
 * an export directory, or at a single file (which is wrapped as a one-artifact
 * source so a single-file format still works through the multi-file seam).
 *
 * Throws if `path` does not exist.
 */
export function resolveSource(path: string): MultiArtifactSource {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    const files: Record<string, ImportArtifact> = {};
    collect(path, path, files);
    return { rootDir: path, files };
  }
  // A single file: expose it under its basename.
  const name = path.split(/[/\\]/).pop() ?? path;
  const bytes = new Uint8Array(readFileSync(path));
  return {
    rootDir: path.slice(0, path.length - name.length).replace(/[/\\]$/, "") || ".",
    files: {
      [name]: {
        name,
        path,
        bytes,
        text: stripBom(new TextDecoder("utf-8").decode(bytes)),
      },
    },
  };
}

/**
 * Looks up a required file in a `MultiArtifactSource`. On a miss it appends a
 * clear, named error to `errors` and returns `null`, so a parser can collect
 * every missing file before failing.
 */
export function requireFile(
  input: MultiArtifactSource,
  name: string,
  errors: string[],
): ImportArtifact | null {
  const file = input.files[name];
  if (!file) {
    errors.push(`required export file '${name}' is missing`);
    return null;
  }
  return file;
}
