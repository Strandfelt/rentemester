import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";

export function writeTempFileFor(finalPath: string, content: string | Uint8Array) {
  const tempPath = join(dirname(finalPath), `.${basename(finalPath)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tempPath, content);
  return tempPath;
}

export function promoteTempFile(tempPath: string, finalPath: string) {
  renameSync(tempPath, finalPath);
}

export function removeIfExists(path: string) {
  try {
    unlinkSync(path);
  } catch {
    // best effort cleanup
  }
}
