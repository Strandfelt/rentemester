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
  test("a healthy company has no flags", () => {
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

  test("a negative result is critical", () => {
    expect(attentionLevel(summary({ resultat: -500 }))).toBe("critical");
  });

  test("open tasks are a warning, not critical", () => {
    expect(attentionLevel(summary({ openTaskCount: 2 }))).toBe("warning");
  });

  test("a VAT deadline within 30 days is a warning", () => {
    const c = summary({
      vat: { payable: 3371.2, deadline: "2026-06-01", daysRemaining: 12 },
    });
    expect(attentionLevel(c)).toBe("warning");
  });

  test("an overdue VAT deadline is critical", () => {
    const c = summary({
      vat: { payable: 3371.2, deadline: "2026-01-01", daysRemaining: -4 },
    });
    expect(attentionLevel(c)).toBe("critical");
  });

  test("a negative result outranks open tasks to critical", () => {
    const c = summary({ resultat: -100, openTaskCount: 3 });
    expect(attentionLevel(c)).toBe("critical");
  });
});

describe("sortByAttention", () => {
  test("orders critical, then warning, then ok", () => {
    const ok = summary({ slug: "ok-co", name: "Ok Co" });
    const warn = summary({
      slug: "warn-co",
      name: "Warn Co",
      openTaskCount: 1,
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
