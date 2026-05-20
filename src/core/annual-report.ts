// Annual report (#177): year-end close + arsrapport assembly for Danish
// regnskabsklasse B (micro / small).
//
// `buildAnnualReport` takes a fiscal year, verifies its prerequisites
// (registered CVR, balanced books, the year fully covered by a closed/reported
// accounting period) and assembles the arsrapport content — resultatopgorelse,
// balance, a notes skeleton and a ledelsespategning placeholder.
//
// It is a pure read: it queries the ledger via the #176 financial-statements
// functions, never mutates the database, never calls the wall clock, and
// produces byte-identical output for identical input.
//
// Conservative by design: Rentemester PREPARES the arsrapport; the owner or
// advisor reviews it and is responsible for the actual Erhvervsstyrelsen
// filing. No direct submission to Virk; regnskabsklasse C/D and corporate tax
// are out of scope.

import type { Database } from "bun:sqlite";
import { isValidIsoDate as looksLikeIsoDate } from "./dates";
import {
  buildBalanceSheet,
  buildProfitAndLoss,
  buildTrialBalance,
  type BalanceSheetReport,
  type ProfitAndLossReport,
} from "./financial-statements";

const ANNUAL_REPORT_RULE_ID = "DK-ANNUAL-REPORT-CLASS-B-001";

/** Company master data echoed onto the arsrapport. */
export type AnnualReportCompany = {
  name: string;
  cvr: string;
  country: string;
  currency: string;
};

/** One note in the (bounded) regnskabsklasse-B notes skeleton. */
export type AnnualReportNote = {
  /** Stable note identifier, e.g. "accounting-policies". */
  id: string;
  /** Danish note heading. */
  title: string;
  /** Placeholder body — the owner/advisor completes the wording. */
  body: string;
  /** True while the note is an un-reviewed placeholder. */
  placeholder: boolean;
};

/** The ledelsespategning (management's statement) placeholder. */
export type AnnualReportLedelsespategning = {
  text: string;
  placeholder: boolean;
};

export type AnnualReport = {
  ok: boolean;
  appliedRules: string[];
  /** Always "B" — this slice only covers regnskabsklasse B (micro/small). */
  regnskabsklasse: "B";
  fiscalYearStart: string;
  fiscalYearEnd: string;
  company: AnnualReportCompany;
  /** Resultatopgorelse for the fiscal year (reused from #176). */
  profitAndLoss: ProfitAndLossReport;
  /** Balance as of the fiscal-year end (reused from #176). */
  balanceSheet: BalanceSheetReport;
  /** Aarets resultat — the year's net result, DKK. Mirrors profitAndLoss.result. */
  aretsResultat: number;
  /** Notes skeleton — placeholders the owner/advisor completes. */
  notes: AnnualReportNote[];
  ledelsespategning: AnnualReportLedelsespategning;
  /** Conservative claim: who prepared the report. */
  preparedBy: "Rentemester";
  /** Conservative-language disclaimer (Danish). */
  disclaimer: string;
  errors: string[];
};

type CompanyRow = {
  name: string;
  country: string;
  currency: string;
  cvr: string | null;
};

type PeriodRow = {
  period_start: string;
  period_end: string;
  kind: string;
  status: string;
};

const DISCLAIMER =
  "Rentemester forbereder denne arsrapport ud fra det lukkede regnskabsaar. " +
  "Ejer eller revisor gennemgar og er ansvarlig for indberetning til Erhvervsstyrelsen.";

function emptyCompany(): AnnualReportCompany {
  return { name: "", cvr: "", country: "DK", currency: "DKK" };
}

function failure(
  fiscalYearStart: string,
  fiscalYearEnd: string,
  company: AnnualReportCompany,
  errors: string[],
  profitAndLoss: ProfitAndLossReport,
  balanceSheet: BalanceSheetReport,
): AnnualReport {
  return {
    ok: false,
    appliedRules: [ANNUAL_REPORT_RULE_ID],
    regnskabsklasse: "B",
    fiscalYearStart,
    fiscalYearEnd,
    company,
    profitAndLoss,
    balanceSheet,
    aretsResultat: 0,
    notes: [],
    ledelsespategning: { text: "", placeholder: true },
    preparedBy: "Rentemester",
    disclaimer: DISCLAIMER,
    errors,
  };
}

/**
 * The regnskabsklasse-B notes skeleton. Deliberately a small, fixed set of
 * placeholders — Rentemester provides the structure; the owner/advisor writes
 * the substance. Order is fixed for deterministic output.
 */
function buildNotesSkeleton(): AnnualReportNote[] {
  return [
    {
      id: "accounting-policies",
      title: "Anvendt regnskabspraksis",
      body:
        "Arsrapporten er aflagt efter arsregnskabslovens bestemmelser for " +
        "regnskabsklasse B. Udfyldes/gennemgas af ejer eller revisor.",
      placeholder: true,
    },
    {
      id: "staff-costs",
      title: "Personaleomkostninger",
      body: "Note-skelet. Udfyldes af ejer eller revisor.",
      placeholder: true,
    },
    {
      id: "equity",
      title: "Egenkapital",
      body: "Note-skelet for egenkapitalens bevaegelser. Udfyldes af ejer eller revisor.",
      placeholder: true,
    },
    {
      id: "subsequent-events",
      title: "Begivenheder efter balancedagen",
      body: "Note-skelet. Udfyldes af ejer eller revisor.",
      placeholder: true,
    },
  ];
}

function buildLedelsespategning(fiscalYearEnd: string): AnnualReportLedelsespategning {
  return {
    placeholder: true,
    text:
      "Ledelsen har dags dato behandlet og godkendt arsrapporten for " +
      `regnskabsaaret, der slutter ${fiscalYearEnd}. Dette er en skabelon — ` +
      "ledelsen indsaetter dato, sted og underskrifter inden indberetning.",
  };
}

/**
 * Assemble a regnskabsklasse-B arsrapport for a fiscal year.
 *
 * Prerequisites (any failure returns ok:false with a clear error):
 *  - valid ISO fiscal-year dates with start <= end;
 *  - a registered company CVR (master data);
 *  - the fiscal year fully covered by a single closed/reported accounting
 *    period (an open or only partially locked year must not be reported);
 *  - balanced books for the fiscal year (double-entry integrity).
 */
export function buildAnnualReport(
  db: Database,
  fiscalYearStart: string,
  fiscalYearEnd: string,
): AnnualReport {
  const profitAndLoss = buildProfitAndLoss(db, fiscalYearStart, fiscalYearEnd);
  const balanceSheet = buildBalanceSheet(db, fiscalYearEnd);

  // 1. Date validation. Surface the underlying report errors verbatim.
  if (!looksLikeIsoDate(fiscalYearStart) || !looksLikeIsoDate(fiscalYearEnd)) {
    return failure(
      fiscalYearStart,
      fiscalYearEnd,
      emptyCompany(),
      ["fiscalYearStart and fiscalYearEnd must be YYYY-MM-DD"],
      profitAndLoss,
      balanceSheet,
    );
  }
  if (fiscalYearStart > fiscalYearEnd) {
    return failure(
      fiscalYearStart,
      fiscalYearEnd,
      emptyCompany(),
      ["fiscalYearStart must be before or equal to fiscalYearEnd"],
      profitAndLoss,
      balanceSheet,
    );
  }

  const errors: string[] = [];

  // 2. Company master data: a registered CVR is mandatory for an arsrapport.
  const companyRow = db
    .query(`SELECT name, country, currency, cvr FROM companies ORDER BY id ASC LIMIT 1`)
    .get() as CompanyRow | null;
  const company: AnnualReportCompany = {
    name: companyRow?.name ?? "",
    cvr: companyRow?.cvr ?? "",
    country: companyRow?.country ?? "DK",
    currency: companyRow?.currency ?? "DKK",
  };
  if (!companyRow) {
    errors.push("company master data is missing — initialise the company first");
  } else if (!companyRow.cvr || !/^DK\d{8}$/.test(companyRow.cvr)) {
    errors.push(
      "company CVR is missing or invalid — an arsrapport requires a registered 8-digit CVR",
    );
  }

  // 3. The fiscal year must be fully locked: a single closed or reported
  // accounting period whose bounds cover the requested year exactly or wider.
  // A still-open year, or a year only partially covered by locked periods,
  // must not be turned into a reportable arsrapport.
  const lockingPeriod = db
    .query(
      `SELECT period_start, period_end, kind, status
         FROM accounting_periods
        WHERE period_start <= ? AND period_end >= ?
          AND status IN ('closed', 'reported')
        ORDER BY period_end ASC, id ASC
        LIMIT 1`,
    )
    .get(fiscalYearStart, fiscalYearEnd) as PeriodRow | null;
  if (!lockingPeriod) {
    errors.push(
      `fiscal year ${fiscalYearStart}..${fiscalYearEnd} is not locked: an arsrapport ` +
        "requires a closed or reported accounting period covering the whole fiscal " +
        "year — run 'period close' first",
    );
  }

  // 4. Books must balance for the fiscal year (double-entry integrity).
  const trialBalance = buildTrialBalance(db, fiscalYearStart, fiscalYearEnd);
  if (trialBalance.ok && !trialBalance.balanced) {
    errors.push(
      `books do not balance for ${fiscalYearStart}..${fiscalYearEnd}: ` +
        `total debit ${trialBalance.totalDebit} != total credit ${trialBalance.totalCredit}`,
    );
  }
  if (!profitAndLoss.ok) errors.push(...profitAndLoss.errors);
  if (!balanceSheet.ok) errors.push(...balanceSheet.errors);

  if (errors.length > 0) {
    return failure(fiscalYearStart, fiscalYearEnd, company, errors, profitAndLoss, balanceSheet);
  }

  return {
    ok: true,
    appliedRules: [ANNUAL_REPORT_RULE_ID],
    regnskabsklasse: "B",
    fiscalYearStart,
    fiscalYearEnd,
    company,
    profitAndLoss,
    balanceSheet,
    aretsResultat: profitAndLoss.result,
    notes: buildNotesSkeleton(),
    ledelsespategning: buildLedelsespategning(fiscalYearEnd),
    preparedBy: "Rentemester",
    disclaimer: DISCLAIMER,
    errors: [],
  };
}
