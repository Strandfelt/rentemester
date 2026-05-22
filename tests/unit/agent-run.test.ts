// Tests: src/agent/loop.ts + src/agent/run.ts (runtime bookkeeper agent #183)
//
// A deterministic end-to-end agent-run against a fixture company. The same
// fixture + same --as-of must produce a stable, asserted run report:
//   - the unambiguous DK expenses (DSB, Elgiganten) book automatically;
//   - everything uncertain — EU reverse-charge purchases blocked by the VIES
//     guardrail, the cash-register receipt, the Stripe payout — lands in the
//     exception queue, never guessed into a posting;
//   - upcoming VAT / year-end deadlines are surfaced.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialiseCompanyVolume } from "../../src/core/company";
import { runAgentLoop } from "../../src/agent/loop";
import { formatRunReport } from "../../src/agent/run";
import { AGENT_ACTOR_ID } from "../../src/agent/contract";
import { openDb, migrate } from "../../src/core/db";
import { companyPaths } from "../../src/core/paths";
import { closeAccountingPeriod } from "../../src/core/periods";

const DEMO_DIR = join(import.meta.dir, "..", "..", "examples", "agent-demo");
const INBOX = join(DEMO_DIR, "inbox");
const METADATA = join(DEMO_DIR, "metadata");
const BANK_CSV = join(DEMO_DIR, "bank.csv");
const AS_OF = "2026-05-20";

function freshCompany(): string {
  const root = mkdtempSync(join(tmpdir(), "rentemester-agent-run-"));
  initialiseCompanyVolume(root, { cvr: "DK12345678" });
  return root;
}

describe("runtime bookkeeper agent — deterministic agent-run (#183)", () => {
  test("books the unambiguous and routes everything uncertain to exceptions", () => {
    const root = freshCompany();
    try {
      const report = runAgentLoop({
        companyRoot: root,
        asOf: AS_OF,
        inboxDir: INBOX,
        metadataDir: METADATA,
        bankCsvPath: BANK_CSV,
      });

      expect(report.ok).toBe(true);
      expect(report.actor).toBe(AGENT_ACTOR_ID);
      expect(report.asOf).toBe(AS_OF);

      // The ordered loop ran every phase.
      expect(report.phases).toEqual([
        "ingest",
        "book",
        "route",
        "reconcile",
        "deadlines",
        "report",
      ]);

      // All 6 bilag ingested; 7 bank transactions imported.
      expect(report.documentsIngested).toBe(6);
      expect(report.documentsRejected).toBe(0);
      expect(report.bankTransactionsImported).toBe(7);

      // The unambiguous standard-VAT operating expenses (deterministic account
      // rule, no foreign-VAT guardrail) book automatically: DSB is a DK
      // supplier; Google Ireland bills DK VAT for Workspace so it is standard
      // too. The Elgiganten purchase is a 12.000 DKK MacBook — an asset-like
      // category — so the loop does NOT auto-book it as an operating expense;
      // it routes it for a fixed-asset decision (#223). The reverse-charge EU
      // purchases (OpenAI, AWS) do NOT auto-book either — the VIES guardrail
      // fires and the agent obeys it.
      const bookedSuppliers = report.expensesBooked.map((e) => e.supplier).sort();
      expect(bookedSuppliers).toEqual(["DSB", "Google Ireland Limited"]);
      for (const e of report.expensesBooked) {
        expect(e.journalEntryNo).toBeTruthy();
        expect(e.vatTreatment).toBe("standard");
      }
      // The asset-sized hardware purchase is never silently expensed.
      expect(bookedSuppliers).not.toContain("Elgiganten A/S");

      // Everything uncertain is in the exception queue — never guessed.
      expect(report.openExceptions.length).toBeGreaterThan(0);
      const exTypes = report.openExceptions.map((x) => x.type).sort();
      // EU reverse-charge purchases blocked by the ledger guardrail.
      expect(exTypes).toContain("AGENT_BOOKING_BLOCKED");
      // The Stripe payout + restaurant receipt are unmatched bank lines.
      expect(exTypes).toContain("UNMATCHED_BANK_TRANSACTION");
      // The 12.000 DKK MacBook is routed for a fixed-asset decision, not
      // booked straight to a P&L expense account (#223).
      expect(exTypes).toContain("AGENT_POSSIBLE_FIXED_ASSET");
      const assetException = report.openExceptions.find(
        (x) => x.type === "AGENT_POSSIBLE_FIXED_ASSET",
      );
      expect(assetException).toBeDefined();
      expect(assetException!.message).toContain("anlægsaktiv");
      expect(assetException!.requiredAction).toContain("asset register");

      // The deadline check surfaces the VAT quarter the company is currently
      // accruing in (Q2 2026, the one containing the as-of date).
      expect(report.upcomingDeadlines.length).toBeGreaterThan(0);
      const vatQuarters = report.upcomingDeadlines.filter((d) => d.kind === "vat_quarter");
      expect(vatQuarters.length).toBeGreaterThan(0);
      const currentQuarter = vatQuarters.find((d) => d.periodStart === "2026-04-01");
      expect(currentQuarter).toBeDefined();
      expect(currentQuarter!.periodEnd).toBe("2026-06-30");
      // The fiscal-year (årsrapport) obligation is surfaced too.
      expect(report.upcomingDeadlines.some((d) => d.kind === "fiscal_year")).toBe(true);

      // The summary is plain-language and non-empty.
      expect(report.summary.length).toBeGreaterThan(0);
      const formatted = formatRunReport(report);
      expect(formatted).toContain("Rentemester runtime-agent");
      expect(formatted).toContain(AGENT_ACTOR_ID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is deterministic: same fixture + same as-of yields an identical report", () => {
    const rootA = freshCompany();
    const rootB = freshCompany();
    try {
      const run = (root: string) =>
        runAgentLoop({
          companyRoot: root,
          asOf: AS_OF,
          inboxDir: INBOX,
          metadataDir: METADATA,
          bankCsvPath: BANK_CSV,
        });
      const a = run(rootA);
      const b = run(rootB);

      // The company root differs, so normalise it before comparing.
      const normalise = (r: ReturnType<typeof run>) => ({ ...r, company: "<root>" });
      expect(normalise(a)).toEqual(normalise(b));

      // The rendered report is byte-identical too (after normalising the root).
      const textA = formatRunReport(a).replaceAll(rootA, "<root>");
      const textB = formatRunReport(b).replaceAll(rootB, "<root>");
      expect(textA).toBe(textB);
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  test("re-running the loop is idempotent and never double-books", () => {
    const root = freshCompany();
    try {
      const first = runAgentLoop({
        companyRoot: root,
        asOf: AS_OF,
        inboxDir: INBOX,
        metadataDir: METADATA,
        bankCsvPath: BANK_CSV,
      });
      const second = runAgentLoop({
        companyRoot: root,
        asOf: AS_OF,
        inboxDir: INBOX,
        metadataDir: METADATA,
        bankCsvPath: BANK_CSV,
      });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      // The second run ingests nothing new (duplicate content) and books
      // nothing new (the expenses are already booked).
      expect(second.documentsIngested).toBe(0);
      expect(second.expensesBooked.length).toBe(0);
      // The open-exception set is stable across re-runs (dedup holds).
      expect(second.openExceptions.length).toBe(first.openExceptions.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an invalid --as-of date without touching the ledger", () => {
    const root = freshCompany();
    try {
      const report = runAgentLoop({ companyRoot: root, asOf: "not-a-date" });
      expect(report.ok).toBe(false);
      expect(report.errors.join(" ")).toContain("--as-of");
      expect(report.expensesBooked).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #282: the agent-run deadline note for a closed VAT period must report the
  // momstilsvar in kroner — `netVatPayable` is already a kroner amount, so
  // labelling it "øre" understates the obligation by a factor of 100.
  test("a closed VAT period's deadline note shows momstilsvar in kroner, not øre (#282)", () => {
    const root = freshCompany();
    try {
      // Close the previous VAT quarter so its deadline note fires the
      // "Momsperioden er lukket" branch with the momstilsvar amount.
      const db = openDb(companyPaths(root).db);
      migrate(db);
      const closed = closeAccountingPeriod(db, {
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
        kind: "vat_quarter",
        createdBy: "system:test",
        createdByProgram: "agent-run-test",
      });
      expect(closed.ok).toBe(true);
      db.close();

      const report = runAgentLoop({ companyRoot: root, asOf: AS_OF });
      expect(report.ok).toBe(true);

      const closedQuarter = report.upcomingDeadlines.find(
        (d) => d.kind === "vat_quarter" && d.periodStart === "2026-01-01" && d.ready,
      );
      expect(closedQuarter).toBeDefined();
      // The note must use the kroner formatter ("kr.") and must NOT label the
      // amount as "øre".
      expect(closedQuarter!.note).toContain("momstilsvar");
      expect(closedQuarter!.note).toContain("kr.");
      expect(closedQuarter!.note).not.toContain("øre");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a deadline-only run (no inbox, no bank) still checks deadlines", () => {
    const root = freshCompany();
    try {
      const report = runAgentLoop({ companyRoot: root, asOf: AS_OF });
      expect(report.ok).toBe(true);
      expect(report.documentsIngested).toBe(0);
      expect(report.bankTransactionsImported).toBe(0);
      expect(report.phases).toContain("deadlines");
      expect(report.upcomingDeadlines.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
