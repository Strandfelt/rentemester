import type { Database } from "bun:sqlite";

export function nextSequenceValue(db: Database, kind: string, scope: string, currentFloor = 0) {
  const row = db.query(
    `INSERT INTO sequences (kind, scope, value)
     VALUES (?, ?, ?)
     ON CONFLICT(kind, scope) DO UPDATE SET value = value + 1
     RETURNING value`
  ).get(kind, scope, currentFloor + 1) as { value: number };
  return Number(row.value);
}

export function yearScopeFromIsoDate(dateText: string) {
  return dateText.slice(0, 4);
}

export function currentUtcYearScope(db: Database) {
  const row = db.query(`SELECT strftime('%Y', CURRENT_TIMESTAMP) AS year`).get() as { year: string };
  return row.year;
}
