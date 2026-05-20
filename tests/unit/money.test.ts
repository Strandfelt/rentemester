// Tests: src/core/money.ts
import { describe, expect, test } from "bun:test";
import { accrueInterestDkk, multiplyDkk, percentOfDkk, roundDkk, roundRate6, sumDkk } from "../../src/core/money";

describe("money helpers", () => {
  test("rounds half-up at øre precision instead of Number.toFixed quirks", () => {
    expect(roundDkk(1.005)).toBe(1.01);
    expect(roundDkk(2.335)).toBe(2.34);
    expect(roundDkk(-1.005)).toBe(-1.01);
  });

  test("sums through integer øre without float drift", () => {
    expect(sumDkk([0.1, 0.2, 0.3])).toBe(0.6);
    expect(sumDkk([1000.1, 2000.2, -0.3])).toBe(3000);
  });

  test("keeps VAT, FX, and interest calculations deterministic", () => {
    expect(percentOfDkk(596.8, 25)).toBe(149.2);
    expect(multiplyDkk(100, 7.46)).toBe(746);
    expect(roundRate6(7.4555555)).toBe(7.455556);
    expect(accrueInterestDkk(250, 10.2, 5)).toBe(0.35);
  });
});
