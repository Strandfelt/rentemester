import { describe, expect, test } from "bun:test";
import { isValidIsoDate } from "../../src/core/dates";

describe("ISO date validation", () => {
  test("accepts real calendar dates including leap day", () => {
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("2026-05-16")).toBe(true);
  });

  test("rejects impossible calendar dates even when the format matches", () => {
    expect(isValidIsoDate("2026-02-30")).toBe(false);
    expect(isValidIsoDate("2025-04-31")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("2026-00-00")).toBe(false);
  });
});
