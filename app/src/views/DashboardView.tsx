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
import { formatKroner, formatPercent } from "../lib/format";
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
          <p className="period-head muted">
            Regnskabsår {o.selectedYear} ·{" "}
            {o.lastPostedDate
              ? `Senest bogført pr. ${o.lastPostedDate}`
              : "Ingen posteringer bogført endnu"}
          </p>

          <div className="kpi-row">
            <KpiCard
              label="Omsætning"
              value={formatKroner(o.profitAndLoss.omsaetning, currency)}
              tone="neutral"
              to={statementTo(slug, "resultatopgorelse", o.selectedYear)}
            />
            <KpiCard
              label="Udgifter"
              value={formatKroner(o.profitAndLoss.udgifter, currency)}
              tone="neutral"
              to={statementTo(slug, "resultatopgorelse", o.selectedYear)}
            />
            <KpiCard
              label="Resultat"
              value={formatKroner(o.profitAndLoss.resultat, currency)}
              sub={`Regnskabsår ${o.selectedYear}`}
              tone={positive ? "result-positive" : "result-negative"}
              emphasised
              to={statementTo(slug, "resultatopgorelse", o.selectedYear)}
            />
          </div>

          <KeyFigures keyFigures={o.keyFigures} />

          <div className="section">
            <h3>Indtægter og udgifter — {o.selectedYear}</h3>
            <div className="card chart-card">
              <PnlChart months={o.profitAndLoss.months} />
            </div>
          </div>

          <div className="status-grid">
            <BankCard
              bank={o.bank}
              currency={currency}
              to={statementTo(slug, "bank", o.selectedYear)}
            />
            <VatCard
              vat={o.vat}
              currency={currency}
              to={statementTo(slug, "moms", o.selectedYear)}
            />
            <ReceivablesCard
              receivables={o.receivables}
              currency={currency}
              to={statementTo(slug, "fakturaer", o.selectedYear)}
            />
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
// Drill-down routing — the Overblik cards link into the detailed views
// --------------------------------------------------------------------------

/** A per-company sub-view route that carries the selected fiscal year. */
function statementTo(slug: string, view: string, year: string): string {
  const suffix = year ? `?year=${encodeURIComponent(year)}` : "";
  return `/companies/${slug}/${view}${suffix}`;
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
  to,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: "neutral" | "result-positive" | "result-negative";
  emphasised?: boolean;
  /** When given, the whole card is a drill-down link. */
  to?: string;
}) {
  const className = `kpi ${tone}${emphasised ? " emphasised" : ""}`;
  const body = (
    <>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </>
  );
  if (to) {
    return (
      <Link className={`${className} kpi-link`} to={to}>
        {body}
      </Link>
    );
  }
  return <div className={className}>{body}</div>;
}

// --------------------------------------------------------------------------
// Nøgletal — two key ratios read off the figures already on the page
// --------------------------------------------------------------------------

function KeyFigures({
  keyFigures,
}: {
  keyFigures: CompanyOverview["keyFigures"];
}) {
  return (
    <div className="key-figures">
      <div className="key-figure">
        <span className="key-figure-label">Bruttomargin</span>
        <span className="key-figure-value">
          {formatPercent(keyFigures.bruttomargin)}
        </span>
        <span className="key-figure-note">resultat ÷ omsætning</span>
      </div>
      <div className="key-figure">
        <span className="key-figure-label">Egenkapitalandel</span>
        <span className="key-figure-value">
          {formatPercent(keyFigures.egenkapitalandel)}
        </span>
        <span className="key-figure-note">egenkapital ÷ balancesum</span>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Status cards
// --------------------------------------------------------------------------

function StatusCard({
  title,
  children,
  to,
}: {
  title: string;
  children: React.ReactNode;
  /** When given, the whole card is a drill-down link. */
  to?: string;
}) {
  if (to) {
    return (
      <Link className="card status-card status-card-link" to={to}>
        <h3>{title}</h3>
        {children}
      </Link>
    );
  }
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
  to,
}: {
  bank: CompanyOverview["bank"];
  currency: string;
  to: string;
}) {
  const { balance, actualBalance, difference } = bank;
  // The actual statement balance is the headline figure when it is known —
  // it is what the owner's bank app shows. The booked balance and the gap
  // sit below it, clearly labelled, so a difference is never mistaken.
  const reconciled = difference !== null && Math.abs(difference) < 0.005;
  return (
    <StatusCard title="Bank" to={to}>
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
  to,
}: {
  vat: CompanyOverview["vat"];
  currency: string;
  to: string;
}) {
  // The half-yearly momsangivelse is easy to forget — surface the statutory
  // filing/payment deadline and a "X dage tilbage" countdown right on the card.
  const days = vat.daysRemaining;
  const countdown =
    days < 0
      ? `Fristen overskredet ${Math.abs(days)} ${
          Math.abs(days) === 1 ? "dag" : "dage"
        }`
      : days === 0
        ? "Frist i dag"
        : `${days} ${days === 1 ? "dag" : "dage"} tilbage`;
  const tone = days <= 30 ? (days < 0 ? "critical" : "warning") : "ok";
  return (
    <StatusCard title="Moms" to={to}>
      <div className="status-figure">
        {formatKroner(vat.payable, currency)}
      </div>
      <p className="muted status-note">
        {vat.periodLabel} · {vat.payable >= 0 ? "at betale" : "tilgode"}
      </p>
      <p className="muted status-note">
        Frist {vat.deadline} ·{" "}
        <span className={`bank-diff ${tone === "ok" ? "ok" : "alert"}`}>
          {countdown}
        </span>
      </p>
    </StatusCard>
  );
}

function ReceivablesCard({
  receivables,
  currency,
  to,
}: {
  receivables: CompanyOverview["receivables"];
  currency: string;
  to: string;
}) {
  // "Hvem skylder mig" — the open balance of issued sales invoices. For a
  // company with no outstanding receivables (Helheim) this is a clean zero.
  const { openCount, openTotal } = receivables;
  return (
    <StatusCard title="Tilgodehavender" to={to}>
      <div
        className={`status-figure${openTotal > 0 ? " status-alert" : ""}`}
      >
        {formatKroner(openTotal, currency)}
      </div>
      <p className="muted status-note">
        {openCount === 0
          ? "Ingen udestående fakturaer — ingen skylder dig penge."
          : `${openCount} ${
              openCount === 1 ? "faktura" : "fakturaer"
            } afventer betaling fra kunder.`}
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
        <ul className="recent-entries">
          {entries.map((e) => (
            <li key={e.id} className="recent-entry">
              <span className="recent-entry-text">{e.text}</span>
              <span className="recent-entry-meta">
                <span className="entry-date">{e.date}</span>
                <span className="recent-entry-amount num">
                  {formatKroner(e.amount, currency)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </StatusCard>
  );
}

export type { OverviewMonth };
