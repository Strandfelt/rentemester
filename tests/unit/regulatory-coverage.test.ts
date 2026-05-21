// Tests: src/core/regulatory-coverage.ts, src/core/rules-metadata.ts
import { describe, expect, test } from "bun:test";
import { computeRegulatoryCoverage } from "../../src/core/regulatory-coverage";
import { parseRuleBundle, readRuleMetadata } from "../../src/core/rules-metadata";

describe("regulatory coverage", () => {
  test("no rule citation has a closure error", () => {
    // A closure error means a rule cites a statutory provision that does not
    // resolve in its declared source. The graph of rule -> law must close.
    const coverage = computeRegulatoryCoverage();
    expect(coverage.closureErrors).toEqual([]);
  });

  test("no rule citation has a drift error", () => {
    // A drift error means the cited provision's text hash no longer matches
    // the extractor — the legislation text changed since the rule was reviewed.
    const coverage = computeRegulatoryCoverage();
    expect(coverage.driftErrors).toEqual([]);
  });

  test("computeRegulatoryCoverage is deterministic", () => {
    const first = computeRegulatoryCoverage();
    const second = computeRegulatoryCoverage();
    expect(first).toEqual(second);
  });

  test("the coverage metric is internally consistent", () => {
    const coverage = computeRegulatoryCoverage();
    expect(coverage.overall.operativeCount).toBeGreaterThanOrEqual(0);
    expect(coverage.overall.citedCount).toBeGreaterThanOrEqual(0);
    expect(coverage.overall.citedCount).toBeLessThanOrEqual(coverage.overall.operativeCount);

    let summedOperative = 0;
    let summedCited = 0;
    for (const source of coverage.perSource) {
      expect(source.citedCount).toBeGreaterThanOrEqual(0);
      expect(source.citedCount).toBeLessThanOrEqual(source.operativeCount);
      expect(source.coveredRefs.length).toBe(source.citedCount);
      expect(source.uncoveredRefs.length).toBe(source.operativeCount - source.citedCount);
      summedOperative += source.operativeCount;
      summedCited += source.citedCount;
    }
    expect(summedOperative).toBe(coverage.overall.operativeCount);
    expect(summedCited).toBe(coverage.overall.citedCount);
  });

  test("uncited rules are exactly the rules with no provisions block", () => {
    const coverage = computeRegulatoryCoverage();
    const expectedUncited = readRuleMetadata()
      .filter((rule) => rule.provisions.length === 0)
      .map((rule) => rule.ruleId)
      .sort();
    expect(coverage.uncitedRules).toEqual(expectedUncited);
  });

  test("the reverse map carries code and test files for every cited rule", () => {
    const coverage = computeRegulatoryCoverage();
    expect(coverage.reverseMap.length).toBeGreaterThan(0);
    let withCode = 0;
    for (const record of coverage.reverseMap) {
      for (const entry of record.rules) {
        if (entry.codeFiles.length > 0) withCode += 1;
      }
    }
    expect(withCode).toBeGreaterThan(0);
  });

  test("the reverse map only references cited provisions and known rules", () => {
    const coverage = computeRegulatoryCoverage();
    const ruleIds = new Set(readRuleMetadata().map((rule) => rule.ruleId));
    const citedKeys = new Set<string>();
    for (const source of coverage.perSource) {
      for (const ref of source.coveredRefs) citedKeys.add(`${source.sourceId} ${ref}`);
    }
    for (const record of coverage.reverseMap) {
      expect(citedKeys.has(`${record.sourceId} ${record.ref}`)).toBe(true);
      for (const entry of record.rules) {
        expect(ruleIds.has(entry.ruleId)).toBe(true);
        expect(Array.isArray(entry.codeFiles)).toBe(true);
        expect(Array.isArray(entry.testFiles)).toBe(true);
      }
    }
  });
});

describe("rule citation parser rejects malformed input", () => {
  const ruleHead = [
    "rules:",
    "  - rule_id: DK-TEST-001",
    "    name: test rule",
    "    category: test",
    "    source_id: DK-RENTELOVEN-2014-459",
  ];

  test("a citation with a ref but no text_hash throws instead of dropping it", () => {
    const yaml = [
      ...ruleHead,
      "    provisions:",
      '      - ref: "§ 3, stk. 1"',
      "    severity: hard_stop",
    ].join("\n");
    expect(() => parseRuleBundle(yaml, "invoices")).toThrow(/ref and text_hash/);
  });

  test("a provisions entry that is not `- ref: ...` throws", () => {
    const yaml = [
      ...ruleHead,
      "    provisions:",
      '      - text_hash: "sha256:abc"',
      "    severity: hard_stop",
    ].join("\n");
    expect(() => parseRuleBundle(yaml, "invoices")).toThrow(/must be/);
  });

  test("tab indentation throws", () => {
    const yaml = [...ruleHead, "\tseverity: hard_stop"].join("\n");
    expect(() => parseRuleBundle(yaml, "invoices")).toThrow(/tab indentation/);
  });

  test("a duplicated text_hash within one entry throws", () => {
    const yaml = [
      ...ruleHead,
      "    provisions:",
      '      - ref: "§ 3, stk. 1"',
      '        text_hash: "sha256:abc"',
      '        text_hash: "sha256:def"',
      "    severity: hard_stop",
    ].join("\n");
    expect(() => parseRuleBundle(yaml, "invoices")).toThrow(/duplicate text_hash/);
  });

  test("a well-formed citation parses to a ref/text_hash pair", () => {
    const yaml = [
      ...ruleHead,
      "    provisions:",
      '      - ref: "§ 3, stk. 1"',
      '        text_hash: "sha256:abc"',
      "    severity: hard_stop",
    ].join("\n");
    const rules = parseRuleBundle(yaml, "invoices");
    expect(rules).toHaveLength(1);
    expect(rules[0].provisions).toEqual([{ ref: "§ 3, stk. 1", textHash: "sha256:abc" }]);
  });
});
