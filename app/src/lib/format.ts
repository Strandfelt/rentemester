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

/**
 * Derives the "needs attention" flags for a company summary. The portfolio
 * view sorts on the worst flag and renders the list — keeping the rules here
 * means they are tested once and reused.
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
  if (c.openExceptionCount > 0) {
    flags.push({
      level: "critical",
      label: `${c.openExceptionCount} åbne undtagelser`,
    });
  }
  if (c.overdueInvoiceCount > 0) {
    flags.push({
      level: "warning",
      label: `${c.overdueInvoiceCount} forfaldne fakturaer`,
    });
  }
  if (c.unlinkedBankCount > 0) {
    flags.push({
      level: "warning",
      label: `${c.unlinkedBankCount} uafstemte posteringer`,
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
