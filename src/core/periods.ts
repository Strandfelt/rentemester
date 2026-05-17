import type { Database } from "bun:sqlite";
import { insertAuditLog } from "./actor";

export type AccountingPeriodKind = "vat_quarter" | "fiscal_year" | "custom";
export type AccountingPeriodStatus = "open" | "closed" | "reported";

export type CloseAccountingPeriodInput = {
  periodStart: string;
  periodEnd: string;
  kind?: AccountingPeriodKind;
  status?: Exclude<AccountingPeriodStatus, "open">;
  reference?: string;
  createdBy?: string;
  createdByProgram?: string;
};

export type CloseAccountingPeriodResult = {
  ok: boolean;
  periodId?: number;
  periodStart?: string;
  periodEnd?: string;
  kind?: AccountingPeriodKind;
  status?: Exclude<AccountingPeriodStatus, "open">;
  reference?: string;
  appliedRules: string[];
  errors: string[];
};

const PERIOD_RULE_ID = "DK-BOOKKEEPING-PERIOD-LOCK-001";
const PERIOD_KINDS = new Set<AccountingPeriodKind>(["vat_quarter", "fiscal_year", "custom"]);
const PERIOD_STATUSES = new Set<Exclude<AccountingPeriodStatus, "open">>(["closed", "reported"]);

function looksLikeIsoDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function todayIsoDate() {
  const override = process.env.RENTEMESTER_TODAY;
  if (looksLikeIsoDate(override)) return override!.trim();
  return new Date().toISOString().slice(0, 10);
}

function maxFutureDays() {
  const raw = process.env.RENTEMESTER_MAX_FUTURE_DAYS;
  if (raw === undefined) return 45;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 45;
}

function addDays(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function validateJournalTransactionDate(db: Database, transactionDate: string, fieldName = "transactionDate") {
  const errors: string[] = [];
  if (!looksLikeIsoDate(transactionDate)) return errors;

  const latestAllowedDate = addDays(todayIsoDate(), maxFutureDays());
  if (transactionDate > latestAllowedDate) {
    errors.push(`${fieldName} ${transactionDate} cannot be later than ${latestAllowedDate}`);
  }

  const blocking = db.query(
    `SELECT id, period_start, period_end, kind, status, reference
       FROM accounting_periods
      WHERE period_start <= ?
        AND period_end >= ?
        AND status IN ('closed', 'reported')
      ORDER BY period_end ASC, id ASC
      LIMIT 1`
  ).get(transactionDate, transactionDate) as {
    id: number;
    period_start: string;
    period_end: string;
    kind: AccountingPeriodKind;
    status: Exclude<AccountingPeriodStatus, "open">;
    reference: string | null;
  } | null;

  if (blocking) {
    const referenceText = blocking.reference ? ` ref ${blocking.reference}` : "";
    errors.push(
      `${fieldName} ${transactionDate} falls in ${blocking.status} period ${blocking.kind} ${blocking.period_start}..${blocking.period_end}${referenceText}`
    );
  }

  return errors;
}

export function closeAccountingPeriod(db: Database, input: CloseAccountingPeriodInput): CloseAccountingPeriodResult {
  const appliedRules = [PERIOD_RULE_ID];
  const errors: string[] = [];
  const periodStart = input.periodStart?.trim();
  const periodEnd = input.periodEnd?.trim();
  const kind = (input.kind ?? "vat_quarter").trim() as AccountingPeriodKind;
  const status = (input.status ?? "closed").trim() as Exclude<AccountingPeriodStatus, "open">;
  const reference = input.reference?.trim();

  if (!looksLikeIsoDate(periodStart)) errors.push("periodStart must be YYYY-MM-DD");
  if (!looksLikeIsoDate(periodEnd)) errors.push("periodEnd must be YYYY-MM-DD");
  if (looksLikeIsoDate(periodStart) && looksLikeIsoDate(periodEnd) && periodStart > periodEnd) {
    errors.push("periodStart must be before or equal to periodEnd");
  }
  if (!PERIOD_KINDS.has(kind)) errors.push("kind must be one of vat_quarter, fiscal_year, custom");
  if (!PERIOD_STATUSES.has(status)) errors.push("status must be closed or reported");

  if (errors.length > 0) return { ok: false, appliedRules, errors };

  const overlap = db.query(
    `SELECT id, period_start, period_end, kind
       FROM accounting_periods
      WHERE kind = ?
        AND NOT (period_end < ? OR period_start > ?)
      LIMIT 1`
  ).get(kind, periodStart, periodEnd) as { id: number; period_start: string; period_end: string; kind: AccountingPeriodKind } | null;

  if (overlap) {
    return {
      ok: false,
      appliedRules,
      errors: [`${kind} period ${periodStart}..${periodEnd} overlaps existing period ${overlap.period_start}..${overlap.period_end}`],
    };
  }

  const inserted = db.query(
    `INSERT INTO accounting_periods (
      period_start, period_end, kind, status, closed_at, closed_by, reported_at, reference
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
    RETURNING id`
  ).get(
    periodStart,
    periodEnd,
    kind,
    status,
    input.createdBy ?? null,
    status === "reported" ? new Date().toISOString() : null,
    reference ?? null,
  ) as { id: number };

  insertAuditLog(db, {
    eventType: status === "reported" ? "period_report" : "period_close",
    entityType: "accounting_period",
    entityId: inserted.id,
    message: `${status === "reported" ? "Marked" : "Closed"} ${kind} period ${periodStart}..${periodEnd}${reference ? ` (${reference})` : ""}`,
    createdBy: input.createdBy,
    createdByProgram: input.createdByProgram,
  });

  return {
    ok: true,
    periodId: inserted.id,
    periodStart,
    periodEnd,
    kind,
    status,
    reference,
    appliedRules,
    errors,
  };
}
