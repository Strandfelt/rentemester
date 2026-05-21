# Runtime bookkeeper agent — operating contract (#183)

Rentemesters mission is **"agenten er bogholderen"**. The hands (MCP tools,
CLI), the guardrails (rules, append-only ledger, exception queue) and the
deterministic core features are all built. This document defines the
**packaged runtime bookkeeper agent** that drives them: the recurring
bookkeeping loop, its operating contract, and its hard boundaries.

It is the *spec* side of the code in `src/agent/`. The demo loop in
`examples/agent-demo/` shows the thesis informally; this is the production
form of the same idea — a deterministic, replayable agent run that an
operator or a scheduler invokes on demand.

## What the agent is

| | |
|---|---|
| **Identity** | `agent:rentemester-bookkeeper` — every mutation is attributed to this canonical actor id. |
| **Program** | `rentemester-runtime-agent` — recorded on journal entries it produces. |
| **Rule id** | `DK-RUNTIME-AGENT-001` — stamped on agent-created exceptions. |
| **Entrypoint** | `runAgentLoop()` in `src/agent/loop.ts`; CLI `rentemester agent run`. |
| **Scope** | One company, one run. Not a hosted always-on service. |

The agent is **not** an LLM making free-form decisions at posting time. It is
a deterministic orchestrator: it calls existing, audited core features, and
where a decision cannot be made deterministically from the rules, it routes
the item to a human — it never guesses.

## The periodic loop

The agent always runs these phases, in this fixed order. A later phase may
depend on an earlier one's output.

1. **ingest** — read the bilagsmail / maildrop (`--inbox`), ingest each bilag
   via the document pipeline. A bilag the ledger rejects (and that is not a
   benign duplicate) becomes an `AGENT_DOCUMENT_REJECTED` exception.
2. **book** — import the bank statement (`--bank-csv`), ask the deterministic
   matcher for suggestions, and **book the unambiguous**: a high-confidence
   match *and* exactly one supplier account rule. Booking goes through the
   existing `expense book` feature — the ledger still has the final word.
3. **route** — **route everything uncertain to the exception queue**:
   - `AGENT_LOW_CONFIDENCE_MATCH` — a match below the auto-book threshold.
   - `AGENT_NO_ACCOUNT_RULE` — a confident match but no account rule applies;
     the agent will not guess an account.
   - `AGENT_BOOKING_BLOCKED` — the ledger refused the posting (a guardrail
     fired, e.g. a missing VIES validation); the agent obeys.
4. **reconcile** — sync every bank transaction with no posted journal entry
   into the exception queue (`UNMATCHED_BANK_TRANSACTION`), via the shared
   reconciliation function.
5. **deadlines** — check the VAT-quarter and fiscal-year (årsrapport)
   deadlines relative to `--as-of`. A VAT period that is still open and
   whose filing deadline is near (or past) is escalated as an
   `AGENT_VAT_DEADLINE_OPEN` exception.
6. **report** — produce the end-of-run report: what was booked, what was
   left in exceptions, which deadlines are near.

## Hard boundaries — the guardrails

These are non-negotiable. They are what makes "the agent is the bookkeeper" a
safe claim.

- **The agent never overrules the ledger.** It posts only through the
  existing booking features. When the ledger refuses (period lock, unbalanced
  entry, missing VIES validation, …), the agent records an exception — it
  never forces the posting.
- **The agent never overrules the rules.** Account selection and VAT
  treatment come from an explicit, auditable rule base
  (`SUPPLIER_RULES` in `src/agent/contract.ts`). No rule, or more than one
  rule, means *ambiguous* — and ambiguity is never resolved by guessing.
- **Uncertain ⇒ exception, never a guess.** Every uncertain item lands in the
  exception queue with a `requiredAction` for the human. The queue is the
  contract between the agent and the human.
- **The agent never files.** It surfaces VAT and year-end deadlines; closing
  periods and submitting a momsangivelse / årsrapport stay with the human.
- **Append-only and audited.** Every mutation is attributed to
  `agent:rentemester-bookkeeper` and hash-linked into the audit chain like
  any other actor's work.

## Determinism

The run is **deterministic and replayable**: the same fixture company, the
same inputs and the same `--as-of` date produce a byte-identical run report.

- The only "now" the agent knows is the explicit **`--as-of`** date. There is
  no wall-clock dependence anywhere in the loop.
- Inbox files are processed in a stable sorted order; bank transactions are
  processed in ascending id order.
- Re-running the loop is idempotent: the document pipeline dedups by content,
  expenses already booked are not re-booked, and the exception queue dedups
  identical entries. A second identical run books nothing new.

This is verified by `tests/unit/agent-run.test.ts`, which runs the loop twice
against two fresh copies of the fixture company and asserts the reports are
identical.

## Running it

```
rentemester agent run \
  --company <slug|path> \
  --as-of 2026-05-20 \
  --inbox examples/agent-demo/inbox \
  --metadata-dir examples/agent-demo/metadata \
  --bank-csv examples/agent-demo/bank.csv
```

| Flag | Meaning |
|------|---------|
| `--company` | The company (workspace slug or path). Required. |
| `--as-of` | `YYYY-MM-DD` — the agent's only clock. Required. |
| `--inbox` | Directory of bilag, one document file per bilag, each with a sibling `<stem>.json` metadata file. Optional. |
| `--metadata-dir` | Where the metadata JSON lives (default: same as `--inbox`). |
| `--bank-csv` | A bank-statement CSV imported before matching. Optional. |

Omitting `--inbox` and `--bank-csv` runs a **deadline-only** check — useful
for a scheduler that just wants the upcoming-deadline report.

Output is human-readable by default, or a structured envelope with
`--format json`. The JSON payload is the `AgentRunReport` produced by
`runAgentLoop()` (`src/agent/loop.ts`); its shape is documented below.

## The `--format json` report shape (`AgentRunReport`)

A single run produces one `AgentRunReport` object. Top-level fields:

| Field | Type | Meaning |
|-------|------|---------|
| `ok` | `boolean` | `true` when the run completed without a fatal error. A `false` means the loop aborted (invalid `--as-of`, no initialised company, a missing inbox metadata sibling, a failed bank import, …); `errors[]` then carries the cause. Per-bilag rejections and unbookable transactions do **not** flip `ok` — they become exceptions. |
| `actor` | `string` | The canonical actor id every mutation in this run was booked under (the fixed agent actor). |
| `asOf` | `string` | `YYYY-MM-DD` — the explicit run date echoed back; the agent's only clock. |
| `company` | `string` | Absolute path to the company directory the run operated on. |
| `phases` | `string[]` | The phases the loop executed, in order: `ingest`, `book`, `route`, `reconcile`, `deadlines`, `report`. A run that aborts early lists only the phases reached. |
| `documentsIngested` | `number` | Count of bilag from `--inbox` successfully ingested into the ledger this run. |
| `documentsRejected` | `number` | Count of bilag the ledger refused (rules rejection or duplicate). A non-duplicate rejection also lands in `openExceptions`. |
| `bankTransactionsImported` | `number` | Count of rows imported from `--bank-csv` (`0` when no `--bank-csv` was given). |
| `expensesBooked` | `BookedExpense[]` | The expenses the agent booked automatically — confident bank-match **and** a single deterministic account rule. See below. |
| `openExceptions` | `RoutedException[]` | Exceptions still open at end of run — the human's work list. See below. |
| `upcomingDeadlines` | `DeadlineNotice[]` | VAT-quarter and fiscal-year deadlines relative to `asOf`. See below. |
| `summary` | `string[]` | Plain-language (Danish) lines describing what was done and what needs the human. |
| `errors` | `string[]` | Fatal-error messages. Empty on a clean run. |

`expensesBooked[]` — one `BookedExpense` per auto-booked expense:

| Field | Type | Meaning |
|-------|------|---------|
| `documentNo` | `string` | The bilag's document number (falls back to `DOC-<documentId>`). |
| `documentId` | `number` | The ingested document's id. |
| `bankTransactionId` | `number` | The bank transaction the expense was matched to. |
| `supplier` | `string` | Supplier name (`"ukendt"` when unknown). |
| `amount` | `number` | The bank-transaction amount. |
| `currency` | `string` | Currency of the transaction. |
| `expenseAccount` | `string` | Account number the expense was booked to (from the deterministic supplier rule). |
| `vatTreatment` | `string` | VAT treatment applied (from the supplier rule). |
| `label` | `string` | Human label of the supplier-rule category. |
| `journalEntryNo` | `string \| null` | The posted journal entry number, or `null` if unavailable. |

`openExceptions[]` — one `RoutedException` per open exception:

| Field | Type | Meaning |
|-------|------|---------|
| `exceptionId` | `number` | The exception row id (use it with `exception resolve`). |
| `type` | `string` | The exception type, e.g. `AGENT_DOCUMENT_REJECTED`, `AGENT_LOW_CONFIDENCE_MATCH`, `AGENT_NO_ACCOUNT_RULE`, `AGENT_POSSIBLE_FIXED_ASSET`, `AGENT_BOOKING_BLOCKED`, `AGENT_VAT_DEADLINE_OPEN`. |
| `severity` | `string` | `low` / `medium` / `high`. |
| `message` | `string` | Human-readable description of what the agent could not resolve. |
| `requiredAction` | `string \| null` | The concrete next step for the human, or `null`. |

`upcomingDeadlines[]` — one `DeadlineNotice` per relevant deadline:

| Field | Type | Meaning |
|-------|------|---------|
| `kind` | `"vat_quarter" \| "fiscal_year"` | Which statutory deadline this notice is for. |
| `periodStart` | `string` | `YYYY-MM-DD` start of the period. |
| `periodEnd` | `string` | `YYYY-MM-DD` end of the period. |
| `dueDate` | `string` | `YYYY-MM-DD` statutory filing/finalisation deadline. |
| `daysRemaining` | `number` | Days from `asOf` to `dueDate`; negative when the deadline is already past. |
| `ready` | `boolean` | `true` when the period is already closed/reported and ready to file. `fiscal_year` notices are always `false` (the human finalises the årsrapport). |
| `note` | `string` | Plain-language (Danish) status line for this deadline. |

## Out of scope

- A hosted, always-on service. This is an on-demand loop.
- The cockpit Phase 2 auth (#174).
- An LLM choosing accounts at posting time. The rule base is deterministic;
  swapping in an LLM to *propose* rules offline is a future extension, but the
  posting-time decision must always remain a deterministic lookup.
