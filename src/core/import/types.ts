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
 * The Rentemester account types — mirrors the `accounts.type` CHECK constraint
 * in src/core/schema.sql (the `vat` type is reserved for the seeded moms
 * accounts and is never produced by an importer).
 */
export type ImportAccountType = "asset" | "liability" | "equity" | "income" | "expense";

/** A Rentemester `normal_balance` value (mirrors the schema CHECK constraint). */
export type ImportNormalBalance = "debit" | "credit";

/**
 * One account in the source system's chart of accounts. Carried so the
 * framework can validate that every opening-balance line references a known
 * account and report unknown accounts clearly.
 *
 * A parser that has classified the account (the Dinero parser does) also fills
 * `normalizedType` / `normalBalance` / `defaultVatCode`, so the chart can be
 * reconciled into the live `accounts` table without re-deriving the mapping.
 */
export type ImportAccount = {
  accountNo: string;
  name: string;
  /** Optional source-system account type label, kept for the audit trail. */
  type?: string;
  /** Rentemester account type, when the parser has classified the account. */
  normalizedType?: ImportAccountType;
  /** Rentemester normal balance, when the parser has classified the account. */
  normalBalance?: ImportNormalBalance;
  /** Resolved Rentemester VAT code (`accounts.default_vat_code`), when mapped. */
  defaultVatCode?: string | null;
};

/**
 * The company master data carried by an export (Dinero's `Firmaoplysninger.csv`).
 * Reconciled into the `companies` row by the import flow; fields the schema
 * does not store (address, phone, ...) are kept for the audit trail.
 */
export type ImportCompanyMasterData = {
  name?: string;
  cvr?: string;
  address?: string;
  postalCode?: string;
  city?: string;
  country?: string;
  email?: string;
  phone?: string;
  website?: string;
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
  /** Optional company master data (name, CVR, ...) from the export. */
  companyMasterData?: ImportCompanyMasterData;
  /**
   * Optional list of source VAT-code labels the parser could NOT map onto a
   * Rentemester VAT code. Surfaced by the import flow — never silently dropped.
   */
  unmappedVatCodes?: string[];
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
 * One artifact (file) inside a multi-file export. CSV/text artifacts carry a
 * BOM-stripped UTF-8 `text` decode; binary artifacts (receipt images, ...) are
 * exposed as `path`/`bytes` for downstream ingest.
 */
export type ImportArtifact = {
  /** Export-root-relative, forward-slash file name, e.g. "2025/Kontoplan.csv". */
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** Raw file bytes. */
  bytes: Uint8Array;
  /** BOM-stripped UTF-8 decode of `bytes`. */
  text: string;
};

/**
 * A resolved multi-file export: a root directory plus its artifacts keyed by
 * export-root-relative, forward-slash name. Produced by `resolveSource`
 * (./source.ts) and consumed by a `SourceParser.parseSource`.
 */
export type MultiArtifactSource = {
  rootDir: string;
  files: Record<string, ImportArtifact>;
};

/**
 * THE PARSER CONTRACT.
 *
 * Every per-system importer implements this interface. A parser is
 * intentionally small: it converts a raw export into a normalised
 * `ImportSource` and nothing else. All ledger interaction, validation against
 * the live chart of accounts, and posting is owned by the import flow.
 *
 * Two shapes are supported, both optional so a parser implements exactly the
 * one its format needs:
 *  - `parse(raw)` — a single text file (the synthetic-CSV example).
 *  - `parseSource(input)` + `requiredFiles` — a multi-file export, e.g. a
 *    Dinero export directory. The framework resolves the directory/zip into a
 *    `MultiArtifactSource` and checks `requiredFiles` are present first.
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
  parse?(raw: string): ParseResult;
  /**
   * Export-root-relative, forward-slash file names a multi-file parser needs.
   * Missing required files are a clear, named error before `parseSource` runs.
   */
  readonly requiredFiles?: readonly string[];
  /**
   * Parse a resolved multi-file export into an `ImportSource`. Pure and
   * deterministic with respect to `input`.
   */
  parseSource?(input: MultiArtifactSource): ParseResult;
};

/** Options accepted by `runImport`. */
export type ImportOptions = {
  createdBy?: string;
  createdByProgram?: string;
};

/**
 * The outcome of reconciling a source chart of accounts into the live
 * `accounts` table. Existing accounts are left intact; missing accounts are
 * created. Deterministic and audited — see `reconcileChartOfAccounts`.
 */
export type ChartReconciliationResult = {
  /** Account numbers created in the `accounts` table by this import. */
  created: string[];
  /** Account numbers that already existed and were left untouched. */
  existing: string[];
  /**
   * Human-readable differences between a source account and the existing live
   * account of the same number (name / type / VAT code mismatches).
   */
  differences: string[];
  /** Source VAT-code labels that could not be mapped to a Rentemester code. */
  unmappedVatCodes: string[];
};

/**
 * The outcome of reconciling company master data into the `companies` row.
 * A non-empty field is never overwritten unless `overwrite` was requested.
 */
export type CompanyReconciliationResult = {
  /** `companies` column names that were populated by this import. */
  updatedFields: string[];
  /** Human-readable notes — e.g. a field skipped because it was already set. */
  notes: string[];
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
  /** Chart-of-accounts reconciliation outcome, when the source carried one. */
  chart?: ChartReconciliationResult;
  /** Company-master-data reconciliation outcome, when the source carried one. */
  company?: CompanyReconciliationResult;
  /** Ordered, deterministic human-readable description of what happened. */
  auditTrail: string[];
  appliedRules: string[];
  errors: string[];
};
