export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false;
  const date = new Date(`${trimmed}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === trimmed;
}

/**
 * Today's date as YYYY-MM-DD. Honours the RENTEMESTER_TODAY override for
 * deterministic tests; otherwise reads the wall clock in UTC.
 */
export function todayIsoDate(): string {
  const override = process.env.RENTEMESTER_TODAY;
  if (isValidIsoDate(override)) return override.trim();
  return new Date().toISOString().slice(0, 10);
}

/**
 * Add `days` (may be negative) to a YYYY-MM-DD date and return the resulting
 * YYYY-MM-DD date. UTC-based, so leap years and year boundaries are handled
 * by the calendar without timezone drift.
 */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Signed day difference `toDate - fromDate` between two YYYY-MM-DD dates.
 * Positive when toDate is later, negative when earlier, zero when equal.
 * UTC-based.
 */
export function diffDays(fromDate: string, toDate: string): number {
  const from = new Date(`${fromDate}T00:00:00.000Z`).getTime();
  const to = new Date(`${toDate}T00:00:00.000Z`).getTime();
  return Math.round((to - from) / 86400000);
}

/**
 * Absolute day distance between two YYYY-MM-DD dates, order-independent.
 * UTC-based.
 */
export function daysBetween(a: string, b: string): number {
  return Math.abs(diffDays(a, b));
}
