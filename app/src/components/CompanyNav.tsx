// Per-company chrome shared by every company view (cockpit-redesign it. 2).
//
// Two concerns live here so the four company views stay declarative:
//
//   * `useCompanyYear` — the selected fiscal year, carried in the URL as a
//     `?year=` query param. Carrying it in the route (not React state) means
//     the choice survives navigation between a company's sub-views and a page
//     reload, and every in-app link below preserves it automatically.
//
//   * `CompanyNav` — the sub-navigation bar (Overblik · Resultatopgørelse ·
//     Balance · Saldobalance) plus the fiscal-year selector. Rendered at the
//     top of each company view.

import { NavLink, useSearchParams } from "react-router-dom";
import type { FiscalYearEntry } from "../lib/types";

/**
 * The selected fiscal year as a URL query param. `year` is `undefined` until
 * the user picks one (the backend then defaults to the most recent live
 * year); `setYear` writes it back to the URL so it persists across views.
 */
export function useCompanyYear(): {
  year: string | undefined;
  setYear: (year: string) => void;
} {
  const [params, setParams] = useSearchParams();
  const year = params.get("year") ?? undefined;
  const setYear = (next: string) => {
    const updated = new URLSearchParams(params);
    updated.set("year", next);
    setParams(updated, { replace: true });
  };
  return { year, setYear };
}

const TABS: { to: string; label: string }[] = [
  { to: "", label: "Overblik" },
  { to: "resultatopgorelse", label: "Resultatopgørelse" },
  { to: "balance", label: "Balance" },
  { to: "saldobalance", label: "Saldobalance" },
];

/**
 * The per-company sub-navigation. `slug` keys the links; the current `?year=`
 * is threaded through every tab so the chosen year follows the user across
 * views. `years`/`selectedYear`/`onYearChange` drive the fiscal-year selector.
 */
export function CompanyNav({
  slug,
  years,
  selectedYear,
  onYearChange,
}: {
  slug: string;
  years: FiscalYearEntry[];
  selectedYear: string;
  onYearChange: (year: string) => void;
}) {
  const [params] = useSearchParams();
  const query = params.toString();
  const suffix = query ? `?${query}` : "";

  return (
    <nav className="company-nav" aria-label="Virksomhedsvisninger">
      <div className="company-tabs">
        {TABS.map((tab) => {
          const path = tab.to
            ? `/companies/${slug}/${tab.to}`
            : `/companies/${slug}`;
          return (
            <NavLink key={tab.to} to={`${path}${suffix}`} end>
              {tab.label}
            </NavLink>
          );
        })}
      </div>
      <YearSelector
        years={years}
        selected={selectedYear}
        onChange={onYearChange}
      />
    </nav>
  );
}

/** The fiscal-year dropdown — shared by every company view. */
export function YearSelector({
  years,
  selected,
  onChange,
}: {
  years: FiscalYearEntry[];
  selected: string;
  onChange: (year: string) => void;
}) {
  return (
    <label className="year-selector">
      <span className="ys-label">Regnskabsår</span>
      <select
        value={selected}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Vælg regnskabsår"
      >
        {years.map((y) => (
          <option key={y.label} value={y.label}>
            {y.label}
            {y.source === "archive" ? " (arkiv)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
