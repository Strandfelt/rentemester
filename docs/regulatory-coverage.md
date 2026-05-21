# Regulatory coverage

Regulatory coverage is like code coverage, but it measures how much of the
cited Danish legislation is traceably implemented in Rentemester's rules and
code — not how many lines run, but how many statutory provisions are claimed.

## Citation schema

A rule in `rules/dk/*.yaml` may carry an optional `provisions:` block (by
convention placed right after `source_id:`). Each entry cites one statutory
provision at stk-level or finer and pins the legislation text it was reviewed
against:

```yaml
    source_id: DK-BILAG-OPBEVARING-2023-1383
    provisions:
      - ref: "§ 1, stk. 1"
        text_hash: "sha256:abc123..."
      - ref: "§ 1, stk. 1, nr. 4"
        text_hash: "sha256:def456..."
```

`ref` is a human-readable provision reference; `text_hash` is copied verbatim
from the provision extractor (`src/core/legal-provisions.ts`). A rule with no
`provisions:` block is "uncited".

## What the engine checks

`computeRegulatoryCoverage()` (`src/core/regulatory-coverage.ts`) cross-checks
every citation against the deterministic LexDania extractor:

- **Closure** — a citation must resolve to a provision in the rule's declared
  `source_id`. A `ref` that does not resolve, or resolves only in a different
  source, is a closure error.
- **Drift** — the cited `text_hash` must equal the extractor's current hash for
  that provision. A mismatch means the legislation text changed since the rule
  was reviewed.
- **Coverage** — per source and overall, the fraction of `operative`
  provisions cited by at least one rule (kept as an exact numerator/denominator).

## Running it

```bash
rentemester reg coverage              # human summary
rentemester reg coverage --format json
rentemester reg coverage --out REGULATORY_COVERAGE.md
```

The command is repo-static (no `--company`). The gate test
`tests/unit/regulatory-coverage.test.ts` hard-fails on any closure or drift
error. The coverage percentage is not gated — it is a tracked metric, not a
wall.
