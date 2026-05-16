import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  return db;
}

export function migrate(db: Database) {
  const schema = readFileSync(join(import.meta.dir, "../../src/core/schema.sql"), "utf8");
  db.exec(schema);
}

export function dbExists(path: string) {
  return existsSync(path);
}
