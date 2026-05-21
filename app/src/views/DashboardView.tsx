// Overblik — the per-company overview dashboard (cockpit-redesign iteration 1).
//
// Renders `/api/companies/:slug/overview?year=`: three headline KPI cards
// (Omsætning / Udgifter / Resultat), a month-by-month P&L chart, and a row of
// status cards (Bank, Moms, Opgaver, Seneste posteringer). The per-company
// sub-navigation and fiscal-year selector live in `CompanyNav`; the chosen
// year is carried in the URL (`?year=`) so it follows the user across views.
// All `/overview` money fields are kroner, so `formatKroner` is used
// throughout (never `formatCurrency`, which expects minor units).

import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatKroner } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import type { CompanyOverview, OverviewMonth } from "../lib/types";
import { ErrorState, Loading } from "../components/Feedback";
import { CompanyNav, useCompanyYear } from "../components/CompanyNav";
import { PnlChart } from "../components/PnlChart";

export function DashboardView() {
  const { slug = "" } = useParams();
  const { year, setYear } = useCompanyYear();
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
          <Link className="btn secondary" to={`/companies/${slug}/manage`}>
            Administrér
          </Link>
        </div>
      </div>

      <CompanyNav
        slug={slug}
        years={o.fiscalYears}
        selectedYear={o.selectedYear}
        onYearChange={setYear}
      />

      {o.archived ? (
        <ArchivedNotice slug={slug} year={o.selectedYear} />
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
            <BankCard bank={o.bank} currency={currency} />
            <VatCard vat={o.vat} currency={currency} />
            <ExceptionsCard slug={slug} exceptions={o.exceptions} />
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

function ArchivedNotice({ slug, year }: { slug: string; year: string }) {
  return (
    <div className="card archived-notice">
      <h3>Regnskabsår {year} er arkiveret</h3>
      <p className="muted">
        Dette år ligger i det skrivebeskyttede arkiv og vises ikke i Overblik.
      </p>
      <Link
        className="btn secondary"
        to={`/companies/${slug}/arkiv?year=${year}`}
      >
        Åbn {year} i Arkiv
      </Link>
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
  bank,
  currency,
}: {
  bank: CompanyOverview["bank"];
  currency: string;
}) {
  const { balance, actualBalance, difference } = bank;
  // The actual statement balance is the headline figure when it is known —
  // it is what the owner's bank app shows. The booked balance and the gap
  // sit below it, clearly labelled, so a difference is never mistaken.
  const reconciled = difference !== null && Math.abs(difference) < 0.005;
  return (
    <StatusCard title="Bank">
      <div className="status-figure">
        {formatKroner(actualBalance ?? balance, currency)}
      </div>
      {actualBalance === null ? (
        <p className="muted status-note">
          Bogført saldo på bank- og kassekonti — intet kontoudtog importeret
        </p>
      ) : (
        <p className="muted status-note">
          Kontoudtog {formatKroner(actualBalance, currency)} · Bogført{" "}
          {formatKroner(balance, currency)}
          {difference !== null && (
            <>
              {" · "}
              {reconciled ? (
                <span className="bank-diff ok">Afstemt</span>
              ) : (
                <span className="bank-diff alert">
                  Difference {formatKroner(difference, currency)} — ikke afstemt
                </span>
              )}
            </>
          )}
        </p>
      )}
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

// Maps a cockpit-relative `link` target from a grouped exception to its route.
function exceptionLinkTo(slug: string, link: string | null): string | null {
  if (link === "bank") return `/companies/${slug}/bank`;
  return null;
}

function ExceptionsCard({
  slug,
  exceptions,
}: {
  slug: string;
  exceptions: CompanyOverview["exceptions"];
}) {
  // Exceptions are grouped by type into one Danish, actionable line each, so
  // the card reads "362 banktransaktioner mangler afstemning" rather than
  // listing every individual exception.
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
        <p className="muted status-note">Ingen åbne opgaver.</p>
      ) : (
        <ul className="status-list">
          {exceptions.groups.map((g) => {
            const to = exceptionLinkTo(slug, g.link);
            const body = (
              <>
                <span
                  className={`flag ${
                    g.severity === "high" ? "critical" : "warning"
                  }`}
                >
                  {g.count}
                </span>{" "}
                {g.label}
              </>
            );
            return (
              <li key={g.type}>
                {to ? (
                  <Link className="status-link" to={to}>
                    {body}
                  </Link>
                ) : (
                  body
                )}
              </li>
            );
          })}
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
