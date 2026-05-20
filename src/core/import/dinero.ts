// Import framework — the Dinero export parser. Issue #193 (epic #173).
//
// A Dinero data export is a directory tree. This parser reads the two files
// that carry the company's chart of accounts and master data:
//
//  - `Firmaoplysninger.csv` — one row of company master data.
//  - `<year>/Kontoplan.csv`  — the chart of accounts, one row per account.
//
// Both are semicolon-delimited UTF-8 CSV (a real export may carry a BOM, which
// `resolveSource` strips). The parser produces a normalised `ImportSource`:
// the chart classified onto Rentemester account types, every account's Dinero
// `Momstype` mapped onto a Rentemester VAT code, and the company master data.
//
// Opening balances and historical postings are intentionally NOT produced here
// — they are issues #194 / #195 and read `Posteringer.csv` / `SaldoBalance.csv`.
//
// The parser is PURE and DETERMINISTIC: the same export always yields the same
// `ImportSource`, including the order of `chartOfAccounts` and `unmappedVatCodes`.

import { requireFile } from "./source";
import type {
  ImportAccount,
  ImportAccountType,
  ImportCompanyMasterData,
  ImportNormalBalance,
  MultiArtifactSource,
  ParseResult,
  SourceParser,
} from "./types";

const SYSTEM = "dinero";
const LABEL = "Dinero (data export — chart of accounts & master data)";

const FIRMAOPLYSNINGER = "Firmaoplysninger.csv";

// --- Dinero Momstype -> Rentemester VAT code -------------------------------
//
// Dinero `Momstype` cells are coded labels: a short code, a dash, a Danish
// description (e.g. `U25 - Dansk salgsmoms`). Only the leading code is stable,
// so the mapping keys on it.
//
// Rentemester's VAT codes (rules/dk/vat.yaml) are deliberately few:
//   DK_SALE_25, DK_PURCHASE_25, EU_SERVICE_REVERSE_CHARGE,
//   REPRESENTATION_SPECIAL, DK_BAD_DEBT_25.
//
// A Dinero code with NO Rentemester equivalent (EU/world goods, reverse-charge
// purchase, the unindberettede EU sales code, ...) is intentionally left
// UNMAPPED: the account gets no `default_vat_code` and the code is surfaced in
// `unmappedVatCodes` for human review. Inventing a VAT code Rentemester does
// not have is explicitly out of scope (#193).
const VAT_CODE_MAP: Record<string, string> = {
  // Danish standard-rated sales / purchases.
  U25: "DK_SALE_25",
  I25: "DK_PURCHASE_25",
  // EU service purchases settle as a reverse charge in Rentemester.
  IEUY: "EU_SERVICE_REVERSE_CHARGE",
  // Representation has a special limited-deduction code.
  REP: "REPRESENTATION_SPECIAL",
};

// Dinero codes Rentemester has no equivalent for. Listed explicitly so the
// parser can tell a deliberately-unmapped code apart from an unrecognised one
// (both are surfaced, but the documentation is clearer this way):
//   IEUV  - Varekøb EU (rubrik A - varer)
//   IVV   - Varekøb fra verden
//   IVY   - Ydelseskøb fra verden
//   OBPK  - Dansk køb med omvendt betalingspligt
//   UEUV  - Varesalg EU - Indberettes (rubrik B - varer)
//   UEUV2 - Varesalg EU - Indberettes ikke (rubrik B - varer)
//   UEUY  - Ydelsessalg EU (rubrik B - ydelser)
//   UVV   - Salg af varer til verden (rubrik C)
//   UVY   - Salg af ydelser til verden (rubrik C)

/** Splits a Dinero semicolon-delimited CSV record. The format has no quoting. */
function splitRecord(line: string): string[] {
  return line.split(";").map((cell) => cell.trim());
}

/** Extracts the leading code from a Dinero `Momstype` cell, e.g. `U25 - ...`. */
function vatCodeKey(momstype: string): string {
  const trimmed = momstype.trim();
  if (trimmed.length === 0) return "";
  const dash = trimmed.indexOf("-");
  return (dash > 0 ? trimmed.slice(0, dash) : trimmed).trim();
}

/**
 * Classifies a Dinero account `Type` onto a Rentemester account type. Dinero
 * has no separate `Egenkapital` type — equity accounts sit under `Passiv` and
 * are identified by their account-number range (60000-60040, the registered
 * capital / retained-earnings / dividend block).
 */
function classifyAccount(
  dineroType: string,
  accountNo: string,
): { type: ImportAccountType; normalBalance: ImportNormalBalance } | null {
  const t = dineroType.trim().toLowerCase();
  const no = Number(accountNo);
  if (t === "aktiv") return { type: "asset", normalBalance: "debit" };
  if (t === "indtægt" || t === "indtaegt") return { type: "income", normalBalance: "credit" };
  if (t === "udgift") return { type: "expense", normalBalance: "debit" };
  if (t === "passiv") {
    // Equity is a Passiv sub-range in a Dinero chart.
    if (Number.isInteger(no) && no >= 60000 && no <= 60040) {
      return { type: "equity", normalBalance: "credit" };
    }
    return { type: "liability", normalBalance: "credit" };
  }
  return null;
}

/** Parses the single data row of `Firmaoplysninger.csv` into master data. */
function parseFirmaoplysninger(text: string, errors: string[]): ImportCompanyMasterData | undefined {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    errors.push(`${FIRMAOPLYSNINGER} has no company data row`);
    return undefined;
  }
  const header = splitRecord(lines[0]!);
  const row = splitRecord(lines[1]!);
  const col = (name: string): string | undefined => {
    const idx = header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    if (idx < 0) return undefined;
    const value = (row[idx] ?? "").trim();
    return value.length > 0 ? value : undefined;
  };
  const md: ImportCompanyMasterData = {};
  const name = col("Firmanavn");
  if (name) md.name = name;
  const cvr = col("CvrNr");
  if (cvr) md.cvr = cvr;
  const address = col("Adresse");
  if (address) md.address = address;
  const postalCode = col("Postnr");
  if (postalCode) md.postalCode = postalCode;
  const city = col("By");
  if (city) md.city = city;
  const country = col("Land");
  if (country) md.country = country;
  const email = col("Email");
  if (email) md.email = email;
  const phone = col("Telefonnummer");
  if (phone) md.phone = phone;
  const website = col("Hjemmeside");
  if (website) md.website = website;
  return md;
}

/**
 * Resolves the single `<year>/Kontoplan.csv` artifact. A Dinero export holds
 * one per fiscal year; the chart of accounts is stable across years, so the
 * LAST year (highest folder name) is used deterministically.
 */
function findKontoplan(input: MultiArtifactSource): { name: string; text: string } | null {
  const matches = Object.keys(input.files)
    .filter((n) => /(^|\/)Kontoplan\.csv$/i.test(n))
    .sort();
  if (matches.length === 0) return null;
  const name = matches[matches.length - 1]!;
  return { name, text: input.files[name]!.text };
}

/** Parses `Kontoplan.csv` into classified accounts plus the unmapped VAT codes. */
function parseKontoplan(
  text: string,
  sourceName: string,
  errors: string[],
): { accounts: ImportAccount[]; unmappedVatCodes: string[] } {
  const accounts: ImportAccount[] = [];
  const unmapped = new Set<string>();
  const lines = text.split(/\r?\n/);
  let sawHeader = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    const cells = splitRecord(line);
    // The column-header row: `Nummer;Navn;Type;Momstype;Total`.
    if (!sawHeader) {
      if ((cells[0] ?? "").toLowerCase() === "nummer") {
        sawHeader = true;
        continue;
      }
      errors.push(`${sourceName}: missing the 'Nummer;Navn;Type;Momstype;Total' header row`);
      return { accounts, unmappedVatCodes: [] };
    }
    const accountNo = cells[0] ?? "";
    const name = cells[1] ?? "";
    const dineroType = cells[2] ?? "";
    const momstype = cells[3] ?? "";
    if (!accountNo) {
      errors.push(`${sourceName} line ${i + 1}: account row is missing a Nummer`);
      continue;
    }
    const classified = classifyAccount(dineroType, accountNo);
    if (!classified) {
      errors.push(
        `${sourceName} line ${i + 1}: account '${accountNo}' has an unrecognised Type '${dineroType}'`,
      );
      continue;
    }
    const account: ImportAccount = {
      accountNo,
      name,
      type: dineroType.trim(),
      normalizedType: classified.type,
      normalBalance: classified.normalBalance,
      defaultVatCode: null,
    };
    const key = vatCodeKey(momstype);
    if (key.length > 0) {
      const mapped = VAT_CODE_MAP[key];
      if (mapped) {
        account.defaultVatCode = mapped;
      } else {
        // Unmapped: keep the account VAT-code-free and surface the label.
        unmapped.add(momstype.trim());
      }
    }
    accounts.push(account);
  }
  if (!sawHeader) {
    errors.push(`${sourceName}: missing the 'Nummer;Navn;Type;Momstype;Total' header row`);
  }
  return { accounts, unmappedVatCodes: [...unmapped].sort() };
}

function parseDineroSource(input: MultiArtifactSource): ParseResult {
  const errors: string[] = [];

  const firma = requireFile(input, FIRMAOPLYSNINGER, errors);
  const kontoplan = findKontoplan(input);
  if (!kontoplan) {
    errors.push("required export file '<year>/Kontoplan.csv' is missing");
  }
  if (!firma || !kontoplan) {
    return { ok: false, errors };
  }

  const companyMasterData = parseFirmaoplysninger(firma.text, errors);
  const { accounts, unmappedVatCodes } = parseKontoplan(kontoplan.text, kontoplan.name, errors);

  if (accounts.length === 0) {
    errors.push(`${kontoplan.name}: no accounts parsed from the chart of accounts`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    source: {
      sourceSystem: SYSTEM,
      // The chart-of-accounts import (#193) does not post a primobalance — the
      // cut-over date and opening balances are #194's job. An empty cut-over
      // date keeps the IR honest: this source only reconciles the chart and
      // master data, it is not a postable opening balance.
      cutOverDate: "",
      chartOfAccounts: accounts,
      openingBalances: [],
      ...(companyMasterData ? { companyMasterData } : {}),
      ...(unmappedVatCodes.length > 0 ? { unmappedVatCodes } : {}),
    },
  };
}

/**
 * The Dinero export parser — a multi-file `SourceParser` (the `parseSource`
 * shape, #192). It declares the files it needs and converts a resolved Dinero
 * export into a normalised `ImportSource`.
 */
export const dineroParser: SourceParser = {
  system: SYSTEM,
  label: LABEL,
  requiredFiles: [FIRMAOPLYSNINGER],
  parseSource: parseDineroSource,
};

/** Exposed for documentation/tests — the Dinero `Momstype` -> VAT-code table. */
export { VAT_CODE_MAP };
