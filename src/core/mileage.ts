/**
 * Mileage log (kørselsregnskab) — issue #123.
 *
 * A standalone, append-only REGISTER plus a deterministic period REPORT.
 * Mileage entries are documentation/audit data only: this module does NOT
 * post anything to the journal or ledger. Whether a trip is deductible,
 * and at which rate, is a tax-treatment decision that belongs to the user
 * and their advisor — Rentemester only records the log.
 *
 * The per-kilometre rate is ALWAYS user-supplied: `ratePerKm` is a plain
 * number and `rateBasis` is a free-text, source-backed note the caller
 * confirms. No tax rate is hardcoded here.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { insertAuditLog } from "./actor";
import { isValidIsoDate } from "./dates";
import { multiplyDkk, roundDkk, sumDkk } from "./money";
import { companySequenceScope, currentUtcIsoDate, nextSequenceValue } from "./sequences";
import { writeFileAtomic } from "./atomic-file";

const RULE_ID = "DK-MILEAGE-LOG-001";

export type CreateMileageEntryInput = {
  tripDate: string;
  purpose: string;
  fromLocation: string;
  toLocation: string;
  kilometers: number;
  vehicle: string;
  driver: string;
  /** User-supplied per-kilometre rate. Not a tax rate Rentemester owns. */
  ratePerKm: number;
  /** Free-text, source-backed basis the user confirms (e.g. which official rate table). */
  rateBasis: string;
  /** Optional citation/URL for the rate basis. */
  rateSource?: string;
  notes?: string;
};

export type CreateMileageEntryResult = {
  ok: boolean;
  mileageEntryId?: number;
  entryNo?: string;
  amountBasis?: number;
  appliedRules: string[];
  errors: string[];
};

export type MileageEntryRow = {
  id: number;
  entryNo: string;
  tripDate: string;
  purpose: string;
  fromLocation: string;
  toLocation: string;
  kilometers: number;
  vehicle: string;
  driver: string;
  ratePerKm: number;
  amountBasis: number;
  rateBasis: string;
  rateSource: string | null;
  notes: string | null;
  createdAt: string;
};

export type ListMileageEntriesResult = {
  ok: boolean;
  count: number;
  rows: MileageEntryRow[];
  appliedRules: string[];
  errors: string[];
};

export type MileagePeriodReport = {
  ok: boolean;
  from: string;
  to: string;
  entryCount: number;
  totalKilometers: number;
  totalAmountBasis: number;
  entries: MileageEntryRow[];
  appliedRules: string[];
  errors: string[];
};

export type ExportMileageLogInput = {
  from: string;
  to: string;
  outputDir: string;
};

export type ExportMileageLogResult = {
  ok: boolean;
  jsonPath?: string;
  csvPath?: string;
  from?: string;
  to?: string;
  entryCount?: number;
  totalKilometers?: number;
  totalAmountBasis?: number;
  appliedRules: string[];
  errors: string[];
};

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Amount basis for one trip: kilometres × user-supplied rate, rounded to
 * øre with the shared integer-øre money helpers (no float drift). This is
 * a documentation figure only, never a posted amount.
 */
export function mileageAmountBasis(kilometers: number, ratePerKm: number): number {
  return roundDkk(multiplyDkk(kilometers, ratePerKm));
}

function nextMileageEntryNo(db: Database, tripDate: string): string {
  const year = tripDate.slice(0, 4);
  const scope = companySequenceScope(db, year);
  const row = db
    .query(
      `SELECT COALESCE(MAX(CAST(substr(entry_no, -6) AS INTEGER)), 0) AS n
       FROM mileage_entries WHERE entry_no GLOB ?`,
    )
    .get(`MIL-${year}-[0-9][0-9][0-9][0-9][0-9][0-9]`) as { n: number };
  const next = nextSequenceValue(db, "mileage_entry", scope, Number(row.n ?? 0));
  return `MIL-${year}-${String(next).padStart(6, "0")}`;
}

export function validateMileageEntry(input: CreateMileageEntryInput): string[] {
  const errors: string[] = [];
  if (!hasText(input.tripDate)) errors.push("tripDate is required");
  else if (!isValidIsoDate(input.tripDate.trim())) errors.push("tripDate must be a valid YYYY-MM-DD date");
  if (!hasText(input.purpose)) errors.push("purpose is required");
  if (!hasText(input.fromLocation)) errors.push("fromLocation is required");
  if (!hasText(input.toLocation)) errors.push("toLocation is required");
  if (!isPositiveNumber(input.kilometers)) errors.push("kilometers must be a positive number");
  if (!hasText(input.vehicle)) errors.push("vehicle is required");
  if (!hasText(input.driver)) errors.push("driver is required");
  if (!isPositiveNumber(input.ratePerKm)) errors.push("ratePerKm must be a positive number");
  if (!hasText(input.rateBasis)) errors.push("rateBasis is required (user-supplied / source-backed)");
  return errors;
}

export function createMileageEntry(db: Database, input: CreateMileageEntryInput): CreateMileageEntryResult {
  const errors = validateMileageEntry(input);
  if (errors.length > 0) return { ok: false, appliedRules: [RULE_ID], errors };

  const tripDate = input.tripDate.trim();
  const kilometers = roundDkk(input.kilometers);
  const ratePerKm = input.ratePerKm;
  const amountBasis = mileageAmountBasis(kilometers, ratePerKm);

  const inserted = db.transaction(() => {
    const entryNo = nextMileageEntryNo(db, tripDate);
    const row = db
      .query(
        `INSERT INTO mileage_entries (
           entry_no, trip_date, purpose, from_location, to_location, kilometers,
           vehicle, driver, rate_per_km, amount_basis, rate_basis, rate_source, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        entryNo,
        tripDate,
        input.purpose.trim(),
        input.fromLocation.trim(),
        input.toLocation.trim(),
        kilometers,
        input.vehicle.trim(),
        input.driver.trim(),
        ratePerKm,
        amountBasis,
        input.rateBasis.trim(),
        hasText(input.rateSource) ? input.rateSource.trim() : null,
        hasText(input.notes) ? input.notes.trim() : null,
      ) as { id: number };

    insertAuditLog(db, {
      eventType: "mileage_entry_create",
      entityType: "mileage_entry",
      entityId: row.id,
      message: `Recorded mileage entry ${entryNo} (${tripDate}, ${kilometers} km, ${input.fromLocation.trim()} -> ${input.toLocation.trim()})`,
    });

    return { id: row.id, entryNo };
  }, { immediate: true })();

  return {
    ok: true,
    mileageEntryId: inserted.id,
    entryNo: inserted.entryNo,
    amountBasis,
    appliedRules: [RULE_ID],
    errors: [],
  };
}

function mapRow(row: Record<string, unknown>): MileageEntryRow {
  return {
    id: Number(row.id),
    entryNo: String(row.entry_no),
    tripDate: String(row.trip_date),
    purpose: String(row.purpose),
    fromLocation: String(row.from_location),
    toLocation: String(row.to_location),
    kilometers: Number(row.kilometers),
    vehicle: String(row.vehicle),
    driver: String(row.driver),
    ratePerKm: Number(row.rate_per_km),
    amountBasis: Number(row.amount_basis),
    rateBasis: String(row.rate_basis),
    rateSource: row.rate_source == null ? null : String(row.rate_source),
    notes: row.notes == null ? null : String(row.notes),
    createdAt: String(row.created_at),
  };
}

const SELECT_COLUMNS =
  `id, entry_no, trip_date, purpose, from_location, to_location, kilometers,
   vehicle, driver, rate_per_km, amount_basis, rate_basis, rate_source, notes, created_at`;

export function listMileageEntries(db: Database): ListMileageEntriesResult {
  const rows = db
    .query(`SELECT ${SELECT_COLUMNS} FROM mileage_entries ORDER BY trip_date DESC, id DESC`)
    .all() as Array<Record<string, unknown>>;
  return {
    ok: true,
    count: rows.length,
    rows: rows.map(mapRow),
    appliedRules: [RULE_ID],
    errors: [],
  };
}

/**
 * Deterministic period report: total kilometres and amount basis for every
 * trip with a `tripDate` inside the inclusive `[from, to]` range. Entries
 * are ordered by trip date then id so identical inputs always produce an
 * identical report.
 */
export function buildMileagePeriodReport(
  db: Database,
  range: { from: string; to: string },
): MileagePeriodReport {
  const errors: string[] = [];
  const from = typeof range.from === "string" ? range.from.trim() : "";
  const to = typeof range.to === "string" ? range.to.trim() : "";
  if (!isValidIsoDate(from)) errors.push("from must be a valid YYYY-MM-DD date");
  if (!isValidIsoDate(to)) errors.push("to must be a valid YYYY-MM-DD date");
  if (errors.length === 0 && from > to) errors.push("from cannot be after to");
  if (errors.length > 0) {
    return {
      ok: false,
      from,
      to,
      entryCount: 0,
      totalKilometers: 0,
      totalAmountBasis: 0,
      entries: [],
      appliedRules: [RULE_ID],
      errors,
    };
  }

  const rows = db
    .query(
      `SELECT ${SELECT_COLUMNS} FROM mileage_entries
       WHERE trip_date BETWEEN ? AND ?
       ORDER BY trip_date ASC, id ASC`,
    )
    .all(from, to) as Array<Record<string, unknown>>;
  const entries = rows.map(mapRow);

  return {
    ok: true,
    from,
    to,
    entryCount: entries.length,
    totalKilometers: sumDkk(entries.map((e) => e.kilometers)),
    totalAmountBasis: sumDkk(entries.map((e) => e.amountBasis)),
    entries,
    appliedRules: [RULE_ID],
    errors: [],
  };
}

function csvCell(value: string | number | null): string {
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Writes a deterministic export artifact for the mileage log over a period:
 * a canonical JSON file plus a flat CSV. Re-running with the same data and
 * range produces byte-identical files, so the export is audit-reviewable.
 */
export function exportMileageLog(db: Database, input: ExportMileageLogInput): ExportMileageLogResult {
  const report = buildMileagePeriodReport(db, { from: input.from, to: input.to });
  if (!report.ok) return { ok: false, appliedRules: [RULE_ID], errors: report.errors };
  if (typeof input.outputDir !== "string" || input.outputDir.trim().length === 0) {
    return { ok: false, appliedRules: [RULE_ID], errors: ["outputDir is required"] };
  }

  mkdirSync(input.outputDir, { recursive: true });
  const jsonPath = join(input.outputDir, "mileage-log.json");
  const csvPath = join(input.outputDir, "mileage-log.csv");

  const payload = {
    appliedRules: [RULE_ID],
    from: report.from,
    to: report.to,
    entryCount: report.entryCount,
    totalKilometers: report.totalKilometers,
    totalAmountBasis: report.totalAmountBasis,
    note: "Mileage log only. Rentemester records the trips; tax treatment is the user/advisor's responsibility.",
    entries: report.entries,
  };
  writeFileAtomic(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);

  const header =
    "entry_no,trip_date,purpose,from_location,to_location,kilometers,vehicle,driver,rate_per_km,amount_basis,rate_basis,rate_source";
  const lines = report.entries.map((e) =>
    [
      e.entryNo,
      e.tripDate,
      e.purpose,
      e.fromLocation,
      e.toLocation,
      e.kilometers,
      e.vehicle,
      e.driver,
      e.ratePerKm,
      e.amountBasis,
      e.rateBasis,
      e.rateSource,
    ]
      .map(csvCell)
      .join(","),
  );
  writeFileAtomic(csvPath, [header, ...lines].join("\n") + "\n");

  insertAuditLog(db, {
    eventType: "mileage_log_export",
    entityType: "mileage_log",
    entityId: null,
    message: `Exported mileage log for ${report.from}..${report.to} (${report.entryCount} entries, ${currentUtcIsoDate(db)})`,
  });

  return {
    ok: true,
    jsonPath,
    csvPath,
    from: report.from,
    to: report.to,
    entryCount: report.entryCount,
    totalKilometers: report.totalKilometers,
    totalAmountBasis: report.totalAmountBasis,
    appliedRules: [RULE_ID],
    errors: [],
  };
}
