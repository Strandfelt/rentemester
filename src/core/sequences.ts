import type { Database } from "bun:sqlite";
import { getCompanySettings } from "./company";
import { fiscalYearForDate } from "./fiscal-year";

export function nextSequenceValue(db: Database, kind: string, scope: string, currentFloor = 0) {
  const row = db.query(
    `INSERT INTO sequences (kind, scope, value)
     VALUES (?, ?, ?)
     ON CONFLICT(kind, scope) DO UPDATE SET value = value + 1
     RETURNING value`
  ).get(kind, scope, currentFloor + 1) as { value: number };
  return Number(row.value);
}

export function fiscalYearLabelFromDate(db: Database, dateText: string) {
  const company = getCompanySettings(db);
  return fiscalYearForDate(dateText, company.fiscalYearStartMonth, company.fiscalYearLabelStrategy).identifierLabel;
}

export function currentUtcIsoDate(db: Database) {
  const row = db.query(`SELECT strftime('%Y-%m-%d', CURRENT_TIMESTAMP) AS iso_date`).get() as { iso_date: string };
  return row.iso_date;
}
