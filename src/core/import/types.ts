// Import framework — normalised intermediate representation + parser contract.
// Issue #185.
//
// A business adopting Rentemester from another accounting system (e-conomic,
// Billy, Dinero #173, ...) needs its history brought over. Rather than an
// ad-hoc parser per system, the import framework defines:
//
//  1. A NORMALISED INTERMEDIATE REPRESENTATION (`ImportSource`) — a
//     system-agnostic description of what was exported: the chart of accounts,
//     the per-account opening balances, and optionally historical entries.
//  2. A PARSER CONTRACT (`SourceParser`) — the small interface every
//     per-system parser implements. A parser's only job is to turn a raw
//     export (CSV/XML/JSON text) into an `ImportSource`. It performs NO
//     posting; the framework owns the mapping onto the ledger.
//
// The framework (`runImport`, see ./framework.ts) maps an `ImportSource` onto
// the #179 primobalance target by calling `postOpeningBalance` — it never
// reimplements opening-balance logic. Money is integer øre throughout, exactly
// as the rest of Rentemester.

/**
 * One account in the source system's chart of accounts. Carried so the
 * framework can validate that every opening-balance line references a known
 * account and report unknown accounts clearly.
 */
export type ImportAccount = {
  accountNo: string;
  name: string;
  /** Optional source-system account type label, kept for the audit trail. */
  type?: string;
};

/**
 * One per-account opening balance as exported by the source system. Exactly
 * one of `debitAmount` / `creditAmount` is expected (integer øre); a line
 * carrying both is rejected by the framework.
 */
export type ImportOpeningBalanceLine = {
  accountNo: string;
  debitAmount?: number;
  creditAmount?: number;
  /** Optional per-line text; defaults to the account name when omitted. */
  text?: string;
};

/**
 * An optional historical journal entry from the source system. NOT posted by
 * the current framework — opening balances are the supported target. The shape
 * is defined now so a future iteration (or a parser that captures detail) has
 * a stable place to put it without a breaking change.
 */
export type ImportHistoricalEntry = {
  transactionDate: string;
  text: string;
  lines: ImportOpeningBalanceLine[];
};

/**
 * The normalised intermediate representation. This is the single hand-off
 * point between a per-system parser and the framework: parsers produce it,
 * the framework consumes it.
 */
export type ImportSource = {
  /** Identifier of the source system, e.g. "synthetic-csv", "dinero". */
  sourceSystem: string;
  /** Cut-over date (YYYY-MM-DD) — the day the opening balances are as of. */
  cutOverDate: string;
  /** The source system's chart of accounts. */
  chartOfAccounts: ImportAccount[];
  /** Per-account opening balances (the primobalance to be posted). */
  openingBalances: ImportOpeningBalanceLine[];
  /** Optional historical entries — captured but not posted by `runImport`. */
  historicalEntries?: ImportHistoricalEntry[];
  /** Optional free-text note carried into the primobalance entry. */
  note?: string;
};

/**
 * The result of a parser turning a raw export into an `ImportSource`.
 * `ok === false` carries the reason in `errors` and omits `source`.
 */
export type ParseResult = {
  ok: boolean;
  source?: ImportSource;
  errors: string[];
};

/**
 * THE PARSER CONTRACT.
 *
 * Every per-system importer implements this interface. The Dinero importer
 * (#173) and the future e-conomic / Billy importers all plug in here. A parser
 * is intentionally small: it converts raw export text to a normalised
 * `ImportSource` and nothing else. All ledger interaction, validation against
 * the live chart of accounts, and posting is owned by `runImport`.
 */
export type SourceParser = {
  /** Stable identifier, e.g. "synthetic-csv". Mirrors `ImportSource.sourceSystem`. */
  readonly system: string;
  /** Human-readable label for help text / audit trail. */
  readonly label: string;
  /**
   * Parse a raw export (file contents as a string) into an `ImportSource`.
   * Pure and deterministic: the same input always yields the same output.
   */
  parse(raw: string): ParseResult;
};

/** Options accepted by `runImport`. */
export type ImportOptions = {
  createdBy?: string;
  createdByProgram?: string;
};

/**
 * The outcome of an import. On success it carries the primobalance entry
 * identifiers plus a deterministic, ordered audit trail describing every step
 * the framework took, so the migration is fully traceable.
 */
export type ImportResult = {
  ok: boolean;
  sourceSystem: string;
  cutOverDate?: string;
  entryId?: number;
  entryNo?: string;
  entryHash?: string;
  openingBalanceLineCount: number;
  /** Count of historical entries seen but intentionally not posted. */
  historicalEntriesSkipped: number;
  /** Ordered, deterministic human-readable description of what happened. */
  auditTrail: string[];
  appliedRules: string[];
  errors: string[];
};
