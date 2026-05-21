// Pure presentation helpers — no React, easy to unit-test.

import type { CompanySummary } from "./types";

/** Danish-style amount formatting. Ledger amounts are in minor units (øre). */
export function formatCurrency(minorUnits: number, currency = "DKK"): string {
  const major = minorUnits / 100;
  return new Intl.NumberFormat("da-DK", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(major);
}

/**
 * Danish-style amount formatting for figures already expressed in kroner
 * (DKK with decimals) — e.g. the `/overview` P&L, VAT and bank fields. Use
 * this, not `formatCurrency`, which divides by 100 for minor-unit ledgers.
 */
export function formatKroner(kroner: number, currency = "DKK"): string {
  return new Intl.NumberFormat("da-DK", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(kroner);
}

/**
 * Danish-style percentage formatting for a ratio expressed as a fraction
 * (0–1) — e.g. the Overblik nøgletal (bruttomargin, egenkapitalandel). Returns
 * "—" when the ratio is null (an undefined figure, never a fabricated 0%).
 */
export function formatPercent(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return "—";
  return new Intl.NumberFormat("da-DK", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(fraction);
}

/** Today as YYYY-MM-DD (local) — the default `asOf` for the cockpit. */
export function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type AttentionLevel = "critical" | "warning" | "ok";

export type AttentionFlag = {
  level: Exclude<AttentionLevel, "ok">;
  label: string;
};

/** A VAT deadline within this many days counts as "soon" — a warning. */
const VAT_DEADLINE_SOON_DAYS = 30;

/**
 * Derives the "needs attention" flags for a company. An owner judges a company
 * on its headline health — these flags surface what needs a hand: a broken
 * audit chain, a negative result, an upcoming/overdue VAT deadline, an
 * unreconciled bank statement, and open tasks. Keeping the rules here means
 * they are tested once and reused by the sort and the card.
 */
export function attentionFlags(c: CompanySummary): AttentionFlag[] {
  const flags: AttentionFlag[] = [];
  if (c.ledgerMissing) {
    flags.push({ level: "critical", label: "Mangler regnskab" });
    return flags;
  }
  if (!c.auditChainOk) {
    flags.push({ level: "critical", label: "Revisionskæde brudt" });
  }
  if (c.resultat < 0) {
    flags.push({ level: "critical", label: "Negativt resultat" });
  }
  if (c.vat && c.vat.payable > 0) {
    if (c.vat.daysRemaining < 0) {
      flags.push({ level: "critical", label: "Moms overskredet" });
    } else if (c.vat.daysRemaining <= VAT_DEADLINE_SOON_DAYS) {
      flags.push({
        level: "warning",
        label: `Moms om ${c.vat.daysRemaining} dage`,
      });
    }
  }
  if (c.openTaskCount > 0) {
    flags.push({
      level: "warning",
      label: `${c.openTaskCount} åbne opgaver`,
    });
  }
  return flags;
}

/** The overall level for a company — the worst of its flags. */
export function attentionLevel(c: CompanySummary): AttentionLevel {
  const flags = attentionFlags(c);
  if (flags.some((f) => f.level === "critical")) return "critical";
  if (flags.length > 0) return "warning";
  return "ok";
}

const RANK: Record<AttentionLevel, number> = { critical: 0, warning: 1, ok: 2 };

/**
 * Sorts a portfolio "needs attention" first: critical, then warning, then ok;
 * within a level, archived companies sink and ties break by display name.
 */
export function sortByAttention(companies: CompanySummary[]): CompanySummary[] {
  return [...companies].sort((a, b) => {
    const byLevel = RANK[attentionLevel(a)] - RANK[attentionLevel(b)];
    if (byLevel !== 0) return byLevel;
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return a.name.localeCompare(b.name, "da");
  });
}

/** A short Danish day-relative phrase for a deadline, e.g. "om 12 dage". */
export function formatDeadline(daysRemaining: number): string {
  if (daysRemaining < 0) {
    const n = Math.abs(daysRemaining);
    return `overskredet ${n} ${n === 1 ? "dag" : "dage"}`;
  }
  if (daysRemaining === 0) return "i dag";
  if (daysRemaining === 1) return "i morgen";
  return `om ${daysRemaining} dage`;
}
