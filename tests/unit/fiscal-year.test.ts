import { describe, expect, test } from "bun:test";
import { fiscalYearForDate } from "../../src/core/fiscal-year";

describe("fiscal year helper", () => {
  test("derives start, end, and labels for offset fiscal years", () => {
    const fy = fiscalYearForDate("2026-07-15", 7, "span");
    expect(fy).toEqual({
      startYear: 2026,
      endYear: 2027,
      start: "2026-07-01",
      end: "2027-06-30",
      displayLabel: "2026/27",
      identifierLabel: "2026-27",
    });
  });
});
