// iXBRL generation (#177): deterministic inline-XBRL output for a Danish
// regnskabsklasse-B (micro/small) arsrapport.
//
// `generateIxbrl` turns the assembled {@link AnnualReport} into an XHTML
// document with inline-XBRL (`ix:`) tags. The output is BOUNDED: it maps only
// the declared `IXBRL_TAXONOMY_SUBSET` — a small, fixed set of regnskabsklasse-B
// elements — and emits nothing outside it. This is deliberately NOT the full
// Erhvervsstyrelsen taxonomy; a clearly-scoped, deterministic, well-tested
// subset is the design goal.
//
// The output is byte-stable: identical input yields a byte-identical document
// (and identical sha256). No wall-clock, no random ordering, integer-stable
// money formatting via src/core/money.ts.
//
// Conservative by design: the document is a PREPARED arsrapport for the owner
// or advisor to review; it is not a submission to Virk/Erhvervsstyrelsen.

import { createHash } from "node:crypto";
import { formatAmount } from "./money";
import type { AnnualReport } from "./annual-report";

const IXBRL_RULE_ID = "DK-ANNUAL-REPORT-IXBRL-002";

/** A single fact element in the bounded regnskabsklasse-B taxonomy subset. */
export type IxbrlTaxonomyElement = {
  /** Namespaced element name, e.g. "ar:Revenue". */
  name: string;
  /** "monetary" -> ix:nonFraction; "text" -> ix:nonNumeric. */
  kind: "monetary" | "text";
  /** Human-readable Danish label rendered next to the fact. */
  label: string;
};

/** The bounded iXBRL taxonomy subset Rentemester maps. Micro/small only. */
export type IxbrlTaxonomySubset = {
  scope: string;
  prefix: string;
  namespace: string;
  elements: IxbrlTaxonomyElement[];
};

/**
 * The declared, bounded regnskabsklasse-B taxonomy subset.
 *
 * Element names are namespaced under the rentemester-local `ar` prefix so the
 * output is unambiguous and never mistaken for an official Erhvervsstyrelsen
 * submission. Kept in lock-step with rules/dk/annual-report.yaml.
 */
export const IXBRL_TAXONOMY_SUBSET: IxbrlTaxonomySubset = {
  scope: "regnskabsklasse B (micro/small) — bounded subset",
  prefix: "ar",
  namespace: "urn:rentemester:dk:arsrapport:v1",
  elements: [
    { name: "ar:CompanyName", kind: "text", label: "Virksomhedsnavn" },
    { name: "ar:RegistreredCvr", kind: "text", label: "CVR-nummer" },
    { name: "ar:ReportingPeriodStartDate", kind: "text", label: "Regnskabsaar start" },
    { name: "ar:ReportingPeriodEndDate", kind: "text", label: "Regnskabsaar slut" },
    { name: "ar:Revenue", kind: "monetary", label: "Nettoomsaetning" },
    { name: "ar:OtherOperatingExpenses", kind: "monetary", label: "Andre eksterne omkostninger" },
    { name: "ar:ProfitLossForYear", kind: "monetary", label: "Aarets resultat" },
    { name: "ar:Assets", kind: "monetary", label: "Aktiver i alt" },
    { name: "ar:Liabilities", kind: "monetary", label: "Gaeldsforpligtelser i alt" },
    { name: "ar:Equity", kind: "monetary", label: "Egenkapital i alt" },
  ],
};

export type GenerateIxbrlResult = {
  ok: boolean;
  appliedRules: string[];
  /** The full XHTML+iXBRL document. Empty string on failure. */
  xhtml: string;
  /** sha256 of `xhtml`, for byte-stability checks and manifests. */
  sha256: string;
  errors: string[];
};

function escapeXml(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** A single declared fact, with the value Rentemester resolved for it. */
type ResolvedFact = {
  element: IxbrlTaxonomyElement;
  /** Already-stringified value (formatted money or text). */
  value: string;
};

/**
 * Render one inline-XBRL fact row. Monetary facts use ix:nonFraction with the
 * shared `numeric` context and DKK unit; text facts use ix:nonNumeric.
 */
function renderFactRow(fact: ResolvedFact): string {
  const { element, value } = fact;
  const safeValue = escapeXml(value);
  if (element.kind === "monetary") {
    return (
      `    <tr><th>${escapeXml(element.label)}</th>` +
      `<td><ix:nonFraction name="${escapeXml(element.name)}" ` +
      `contextRef="duration" unitRef="DKK" decimals="2">${safeValue}` +
      `</ix:nonFraction></td></tr>`
    );
  }
  return (
    `    <tr><th>${escapeXml(element.label)}</th>` +
    `<td><ix:nonNumeric name="${escapeXml(element.name)}" ` +
    `contextRef="duration">${safeValue}</ix:nonNumeric></td></tr>`
  );
}

/**
 * Resolve every declared taxonomy element to a fact value from the annual
 * report. Returns null if a declared element cannot be resolved — a guard
 * against drift between the taxonomy subset and this mapping.
 */
function resolveFacts(report: AnnualReport): { facts: ResolvedFact[]; errors: string[] } {
  const errors: string[] = [];
  // Money is rendered via the integer-ore formatter, never raw floats.
  const m = (value: number): string => formatAmount(value) ?? "0.00";
  const values: Record<string, string> = {
    "ar:CompanyName": report.company.name,
    "ar:RegistreredCvr": report.company.cvr,
    "ar:ReportingPeriodStartDate": report.fiscalYearStart,
    "ar:ReportingPeriodEndDate": report.fiscalYearEnd,
    "ar:Revenue": m(report.profitAndLoss.totalIncome),
    "ar:OtherOperatingExpenses": m(report.profitAndLoss.totalExpense),
    "ar:ProfitLossForYear": m(report.aretsResultat),
    "ar:Assets": m(report.balanceSheet.totalAssets),
    "ar:Liabilities": m(report.balanceSheet.liabilities.total),
    "ar:Equity": m(report.balanceSheet.totalLiabilitiesAndEquity - report.balanceSheet.liabilities.total),
  };
  const facts: ResolvedFact[] = [];
  // Iterate the declared subset so the fact order is fixed and bounded.
  for (const element of IXBRL_TAXONOMY_SUBSET.elements) {
    const value = values[element.name];
    if (value === undefined) {
      errors.push(`iXBRL: declared element ${element.name} has no mapping`);
      continue;
    }
    facts.push({ element, value });
  }
  return { facts, errors };
}

/**
 * Generate a deterministic iXBRL (inline-XBRL) XHTML document for an assembled
 * arsrapport.
 *
 * Refuses to run on a failed annual report — there is no reportable arsrapport
 * to tag. The document declares only the bounded micro/small taxonomy subset.
 */
export function generateIxbrl(report: AnnualReport): GenerateIxbrlResult {
  if (!report.ok) {
    return {
      ok: false,
      appliedRules: [IXBRL_RULE_ID],
      xhtml: "",
      sha256: "",
      errors: [
        "cannot generate iXBRL: the annual report did not pass its prerequisites",
        ...report.errors,
      ],
    };
  }

  const cvrDigits = report.company.cvr.replace(/^DK/, "");
  if (!/^\d{8}$/.test(cvrDigits)) {
    return {
      ok: false,
      appliedRules: [IXBRL_RULE_ID],
      xhtml: "",
      sha256: "",
      errors: ["cannot generate iXBRL: a registered 8-digit CVR is required for the xbrli context"],
    };
  }

  const { facts, errors } = resolveFacts(report);
  if (errors.length > 0) {
    return { ok: false, appliedRules: [IXBRL_RULE_ID], xhtml: "", sha256: "", errors };
  }

  const ns = IXBRL_TAXONOMY_SUBSET.namespace;
  const factRows = facts.map(renderFactRow).join("\n");
  const noteRows = report.notes
    .map(
      (note) =>
        `    <tr><th>${escapeXml(note.title)}</th><td>${escapeXml(note.body)}</td></tr>`,
    )
    .join("\n");

  // The iXBRL hidden header carries the xbrli contexts and the DKK unit. The
  // context dates come straight from the (already final) fiscal year, so the
  // document is fully determined by its input.
  const xhtml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<html xmlns="http://www.w3.org/1999/xhtml"',
    '      xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"',
    '      xmlns:xbrli="http://www.xbrl.org/2003/instance"',
    `      xmlns:ar="${escapeXml(ns)}">`,
    "  <head>",
    "    <title>Arsrapport (regnskabsklasse B) — forberedt af Rentemester</title>",
    "  </head>",
    "  <body>",
    '    <div style="display:none">',
    '      <ix:header>',
    '        <ix:references/>',
    '        <ix:resources>',
    '          <xbrli:context id="duration">',
    "            <xbrli:entity>",
    `              <xbrli:identifier scheme="http://www.cvr.dk">${escapeXml(cvrDigits)}</xbrli:identifier>`,
    "            </xbrli:entity>",
    "            <xbrli:period>",
    `              <xbrli:startDate>${escapeXml(report.fiscalYearStart)}</xbrli:startDate>`,
    `              <xbrli:endDate>${escapeXml(report.fiscalYearEnd)}</xbrli:endDate>`,
    "            </xbrli:period>",
    "          </xbrli:context>",
    '          <xbrli:unit id="DKK">',
    "            <xbrli:measure>iso4217:DKK</xbrli:measure>",
    "          </xbrli:unit>",
    "        </ix:resources>",
    "      </ix:header>",
    "    </div>",
    `    <h1>Arsrapport ${escapeXml(report.fiscalYearStart)} — ${escapeXml(report.fiscalYearEnd)}</h1>`,
    "    <p>Regnskabsklasse B (micro/small). Forberedt af Rentemester; " +
      "ejer eller revisor gennemgar og indberetter.</p>",
    "    <h2>Selskabsoplysninger og hovedtal</h2>",
    "    <table>",
    factRows,
    "    </table>",
    "    <h2>Noter (skelet)</h2>",
    "    <table>",
    noteRows,
    "    </table>",
    "    <h2>Ledelsespategning</h2>",
    `    <p>${escapeXml(report.ledelsespategning.text)}</p>`,
    "  </body>",
    "</html>",
    "",
  ].join("\n");

  return {
    ok: true,
    appliedRules: [IXBRL_RULE_ID],
    xhtml,
    sha256: createHash("sha256").update(xhtml).digest("hex"),
    errors: [],
  };
}
