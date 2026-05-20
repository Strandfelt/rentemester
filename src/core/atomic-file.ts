import { closeSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, basename, join } from "node:path";

// O_EXCL | O_CREAT | O_WRONLY: fail if the path already exists. This defeats a
// same-directory symlink pre-plant — a temp name an attacker pre-created (as a
// symlink or a regular file) makes the open fail rather than following the
// link or clobbering the victim file.
const EXCL_CREATE_FLAGS = "wx";

function randomTempPath(finalPath: string) {
  // Unpredictable suffix: pid/timestamp alone are guessable, which is the
  // symlink pre-plant window. randomBytes makes the name unguessable; the
  // exclusive-create flag below makes a guessed name still safe.
  const suffix = `${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}`;
  return join(dirname(finalPath), `.${basename(finalPath)}.${suffix}.tmp`);
}

export function writeTempFileFor(finalPath: string, content: string | Uint8Array) {
  // Retry on the (vanishingly rare) random-name collision; never follow or
  // clobber an existing entry.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tempPath = randomTempPath(finalPath);
    let fd: number;
    try {
      fd = openSync(tempPath, EXCL_CREATE_FLAGS, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      writeSync(fd, typeof content === "string" ? Buffer.from(content) : Buffer.from(content));
    } finally {
      closeSync(fd);
    }
    return tempPath;
  }
  throw new Error(`failed to create exclusive temp file for ${finalPath}`);
}

export function promoteTempFile(tempPath: string, finalPath: string) {
  renameSync(tempPath, finalPath);
}

// Write `content` to `finalPath` atomically: stage into an exclusively-created
// temp file in the same directory, then rename it into place. A crash mid-write
// leaves only the temp file (or nothing) — never a half-written final file.
export function writeFileAtomic(finalPath: string, content: string | Uint8Array) {
  const tempPath = writeTempFileFor(finalPath, content);
  try {
    promoteTempFile(tempPath, finalPath);
  } catch (error) {
    removeIfExists(tempPath);
    throw error;
  }
}

export function removeIfExists(path: string) {
  try {
    unlinkSync(path);
  } catch {
    // best effort cleanup
  }
}
