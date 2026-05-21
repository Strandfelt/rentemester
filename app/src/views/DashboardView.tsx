// Overblik — the per-company overview dashboard (cockpit-redesign iteration 1).
//
// Renders `/api/companies/:slug/overview?year=`: three headline KPI cards
// (Omsætning / Udgifter / Resultat), a month-by-month P&L chart, and a row of
// status cards (Bank, Moms, Opgaver, Seneste posteringer). A global
// fiscal-year selector — fed by `/fiscal-years` — reloads the view for the
// chosen year. All `/overview` money fields are kroner, so `formatKroner` is
// used throughout (never `formatCurrency`, which expects minor units).

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatKroner } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import type { CompanyOverview, OverviewMonth } from "../lib/types";
import { ErrorState, Loading } from "../components/Feedback";
import { PnlChart } from "../components/PnlChart";

export function DashboardView() {
  const { slug = "" } = useParams();
  const [year, setYear] = useState<string | undefined>(undefined);
  const state = useAsync<CompanyOverview>(
    () => api.overview(slug, year),
    [slug, year],
  );

  if (state.loading && !state.data) return <Loading label="Henter overblik…" />;
  if (state.error)
    return <ErrorState message={state.error} onRetry={state.reload} />;

  const o = state.data!;
  const currency = o.company.currency || "DKK";
  const positive = o.profitAndLoss.resultat >= 0;

  return (
    <section className="overview">
      <div className="page-head">
        <div>
          <h2>{o.company.name}</h2>
          <p className="muted">
            {o.company.cvr ? `CVR ${o.company.cvr} · ` : ""}
            {o.company.country} · {currency} · Overblik
          </p>
        </div>
        <div className="row-actions">
          <YearSelector
            years={o.fiscalYears}
            selected={o.selectedYear}
            onChange={(y) => setYear(y)}
          />
          <Link className="btn secondary" to={`/companies/${slug}/manage`}>
            Administrér
          </Link>
        </div>
      </div>

      {o.archived ? (
        <ArchivedNotice year={o.selectedYear} />
      ) : (
        <>
          <div className="kpi-row">
            <KpiCard
              label="Omsætning"
              value={formatKroner(o.profitAndLoss.omsaetning, currency)}
              tone="neutral"
            />
            <KpiCard
              label="Udgifter"
              value={formatKroner(o.profitAndLoss.udgifter, currency)}
              tone="neutral"
            />
            <KpiCard
              label="Resultat"
              value={formatKroner(o.profitAndLoss.resultat, currency)}
              sub={`Regnskabsår ${o.selectedYear}`}
              tone={positive ? "result-positive" : "result-negative"}
              emphasised
            />
          </div>

          <div className="section">
            <h3>Indtægter og udgifter — {o.selectedYear}</h3>
            <div className="card chart-card">
              <PnlChart months={o.profitAndLoss.months} />
            </div>
          </div>

          <div className="status-grid">
            <BankCard balance={o.bank.balance} currency={currency} />
            <VatCard vat={o.vat} currency={currency} />
            <ExceptionsCard exceptions={o.exceptions} />
            <RecentEntriesCard
              entries={o.recentEntries}
              currency={currency}
            />
          </div>
        </>
      )}
    </section>
  );
}

// --------------------------------------------------------------------------
// Fiscal-year selector
// --------------------------------------------------------------------------

function YearSelector({
  years,
  selected,
  onChange,
}: {
  years: CompanyOverview["fiscalYears"];
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

function ArchivedNotice({ year }: { year: string }) {
  return (
    <div className="card archived-notice">
      <h3>Regnskabsår {year} er arkiveret</h3>
      <p className="muted">
        Dette år ligger i det skrivebeskyttede arkiv. Det fulde overblik for
        arkiverede år kommer i en senere udgave — se Arkiv.
      </p>
    </div>
  );
}

// --------------------------------------------------------------------------
// KPI cards
// --------------------------------------------------------------------------

function KpiCard({
  label,
  value,
  sub,
  tone,
  emphasised,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: "neutral" | "result-positive" | "result-negative";
  emphasised?: boolean;
}) {
  return (
    <div className={`kpi ${tone}${emphasised ? " emphasised" : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

// --------------------------------------------------------------------------
// Status cards
// --------------------------------------------------------------------------

function StatusCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card status-card">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function BankCard({
  balance,
  currency,
}: {
  balance: number;
  currency: string;
}) {
  return (
    <StatusCard title="Bank">
      <div className="status-figure">{formatKroner(balance, currency)}</div>
      <p className="muted status-note">Bogført saldo på bank- og kassekonti</p>
    </StatusCard>
  );
}

function VatCard({
  vat,
  currency,
}: {
  vat: CompanyOverview["vat"];
  currency: string;
}) {
  return (
    <StatusCard title="Moms">
      <div className="status-figure">
        {formatKroner(vat.payable, currency)}
      </div>
      <p className="muted status-note">
        {vat.periodLabel} · {vat.payable >= 0 ? "at betale" : "tilgode"}
      </p>
    </StatusCard>
  );
}

function ExceptionsCard({
  exceptions,
}: {
  exceptions: CompanyOverview["exceptions"];
}) {
  return (
    <StatusCard title="Opgaver">
      <div
        className={`status-figure${
          exceptions.count > 0 ? " status-alert" : ""
        }`}
      >
        {exceptions.count}
      </div>
      {exceptions.count === 0 ? (
        <p className="muted status-note">Ingen åbne undtagelser.</p>
      ) : (
        <ul className="status-list">
          {exceptions.rows.map((r) => (
            <li key={r.id}>
              <span
                className={`flag ${
                  r.severity === "high" ? "critical" : "warning"
                }`}
              >
                {r.severity}
              </span>{" "}
              {r.message}
            </li>
          ))}
        </ul>
      )}
    </StatusCard>
  );
}

function RecentEntriesCard({
  entries,
  currency,
}: {
  entries: CompanyOverview["recentEntries"];
  currency: string;
}) {
  return (
    <StatusCard title="Seneste posteringer">
      {entries.length === 0 ? (
        <p className="muted status-note">Ingen posteringer i året endnu.</p>
      ) : (
        <table className="data compact">
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="entry-date">{e.date}</td>
                <td className="entry-text">{e.text}</td>
                <td className="num">{formatKroner(e.amount, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </StatusCard>
  );
}

export type { OverviewMonth };
