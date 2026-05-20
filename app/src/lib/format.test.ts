import { describe, expect, test } from "vitest";
import {
  attentionFlags,
  attentionLevel,
  formatCurrency,
  sortByAttention,
} from "./format";
import { summary } from "../test/fixtures";

describe("formatCurrency", () => {
  test("renders øre as a Danish currency amount", () => {
    // 1.234,56 kr — non-breaking spaces, so just assert the digits + comma.
    const out = formatCurrency(123456);
    expect(out).toMatch(/1.234,56/);
  });

  test("handles zero", () => {
    expect(formatCurrency(0)).toMatch(/0,00/);
  });
});

describe("attentionFlags", () => {
  test("a clean company has no flags", () => {
    expect(attentionFlags(summary())).toEqual([]);
    expect(attentionLevel(summary())).toBe("ok");
  });

  test("a missing ledger is the single critical flag", () => {
    const flags = attentionFlags(summary({ ledgerMissing: true }));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ level: "critical" });
  });

  test("a broken audit chain is critical", () => {
    expect(attentionLevel(summary({ auditChainOk: false }))).toBe("critical");
  });

  test("overdue invoices are a warning, not critical", () => {
    expect(attentionLevel(summary({ overdueInvoiceCount: 2 }))).toBe("warning");
  });

  test("open exceptions outrank overdue invoices to critical", () => {
    const c = summary({ openExceptionCount: 1, overdueInvoiceCount: 3 });
    expect(attentionLevel(c)).toBe("critical");
  });
});

describe("sortByAttention", () => {
  test("orders critical, then warning, then ok", () => {
    const ok = summary({ slug: "ok-co", name: "Ok Co" });
    const warn = summary({
      slug: "warn-co",
      name: "Warn Co",
      overdueInvoiceCount: 1,
    });
    const crit = summary({
      slug: "crit-co",
      name: "Crit Co",
      auditChainOk: false,
    });
    const sorted = sortByAttention([ok, warn, crit]);
    expect(sorted.map((c) => c.slug)).toEqual(["crit-co", "warn-co", "ok-co"]);
  });

  test("archived companies sink within their level", () => {
    const active = summary({ slug: "a", name: "A" });
    const archived = summary({ slug: "b", name: "B", archived: true });
    expect(sortByAttention([archived, active]).map((c) => c.slug)).toEqual([
      "a",
      "b",
    ]);
  });
});
