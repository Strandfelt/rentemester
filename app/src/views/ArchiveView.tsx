// Arkiv — a single archived fiscal year, read-only (cockpit-redesign it. 4).
//
// Renders `/api/companies/:slug/archive/:year`: the archived year's full
// SaldoBalance as a read-only table (every account: number, name, closing
// balance), plus a summary of its archived Posteringer. The view is for
// pre-cut-over years (#197) that live outside the live ledger — it is clearly
// marked "Arkiveret regnskabsår — skrivebeskyttet". All money fields are
// kroner — `formatKroner` is used throughout.
//
// The fiscal-year selector carries `?year=`; this view shows whichever year is
// chosen. Picking a live year (one with no archive data) shows a clear notice
// pointing the user back to that year's live views.

import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatKroner } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import type { CompanyArchiveYear, FiscalYearEntry } from "../lib/types";
import { ErrorState, Loading } from "../components/Feedback";
import { CompanyNav, useCompanyYear } from "../components/CompanyNav";

export function ArchiveView() {
  const { slug = "" } = useParams();
  const { year, setYear } = useCompanyYear();

  // The available fiscal years drive both the selector and the choice of which
  // archived year to load. Resolved first so the selector renders even when
  // the chosen year has no archive data.
  const yearsState = useAsync<FiscalYearEntry[]>(
    () => api.fiscalYears(slug),
    [slug],
  );

  if (yearsState.loading && !yearsState.data)
    return <Loading label="Henter arkiv…" />;
  if (yearsState.error)
    return (
      <ErrorState message={yearsState.error} onRetry={yearsState.reload} />
    );

  const years = yearsState.data!;
  const archiveYears = years.filter((y) => y.source === "archive");
  // Default to the most recent archived year — that is what this view is for.
  const defaultYear =
    archiveYears[0]?.label ?? years[0]?.label ?? "";
  const selectedLabel = year ?? defaultYear;
  const selectedEntry = years.find((y) => y.label === selectedLabel);
  const isArchived = selectedEntry?.source === "archive";

  return (
    <section className="statement">
      <div className="page-head">
        <div>
          <h2>Arkiv</h2>
          <p className="muted">Tidligere regnskabsår · skrivebeskyttet</p>
        </div>
        <div className="row-actions">
          <Link className="btn secondary" to={`/companies/${slug}/manage`}>
            Administrér
          </Link>
        </div>
      </div>

      <CompanyNav
        slug={slug}
        years={years}
        selectedYear={selectedLabel}
        onYearChange={setYear}
      />

      {archiveYears.length === 0 ? (
        <div className="card archived-notice">
          <h3>Ingen arkiverede regnskabsår</h3>
          <p className="muted">
            Denne virksomhed har ingen tidligere år i det skrivebeskyttede
            arkiv.
          </p>
        </div>
      ) : !isArchived ? (
        <LiveYearNotice slug={slug} year={selectedLabel} />
      ) : (
        <ArchiveYearPanel slug={slug} year={selectedLabel} />
      )}
    </section>
  );
}

/** Shown when the selector points at a live (non-archived) year. */
function LiveYearNotice({ slug, year }: { slug: string; year: string }) {
  return (
    <div className="card archived-notice">
      <h3>Regnskabsår {year} er ikke arkiveret</h3>
      <p className="muted">
        {year} er det aktive regnskabsår og vises i de almindelige visninger.
        Vælg et arkiveret år i regnskabsårs-vælgeren, eller gå til{" "}
        <Link to={`/companies/${slug}?year=${year}`}>Overblik</Link>.
      </p>
    </div>
  );
}

/** The archived year itself: SaldoBalance table + posting summary. */
function ArchiveYearPanel({ slug, year }: { slug: string; year: string }) {
  const state = useAsync<CompanyArchiveYear>(
    () => api.archive(slug, year),
    [slug, year],
  );

  if (state.loading && !state.data)
    return <Loading label={`Henter arkiv ${year}…`} />;
  if (state.error)
    return <ErrorState message={state.error} onRetry={state.reload} />;

  const a = state.data!;
  const currency = a.company.currency || "DKK";

  return (
    <>
      <div className="card archive-banner">
        <span className="flag warning">Arkiveret</span>
        <p>
          <strong>Arkiveret regnskabsår {a.year} — skrivebeskyttet.</strong>{" "}
          Dataene kommer fra en {a.sourceSystem}-eksport (#197) og ligger uden
          for den aktive ledger. De kan ikke redigeres.
        </p>
      </div>

      <div className="status-grid archive-summary">
        <div className="card status-card">
          <h3>Posteringer</h3>
          <div className="status-figure">{a.postings.count}</div>
          <p className="muted status-note">
            Arkiverede posteringslinjer · brutto{" "}
            {formatKroner(a.postings.grossTotal, currency)}
          </p>
        </div>
        <div className="card status-card">
          <h3>Konti</h3>
          <div className="status-figure">{a.saldoBalance.length}</div>
          <p className="muted status-note">
            Konti i saldobalancen for {a.year}
          </p>
        </div>
      </div>

      <div className="section">
        <h3>Saldobalance {a.year}</h3>
        <div className="card statement-card table-scroll">
          <table className="data statement-table">
            <thead>
              <tr>
                <th>Konto</th>
                <th>Navn</th>
                <th className="num">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {a.saldoBalance.length === 0 ? (
                <tr>
                  <td colSpan={3} className="empty-inline">
                    Ingen saldobalance i arkivet for dette år.
                  </td>
                </tr>
              ) : (
                a.saldoBalance.map((row) => (
                  <tr key={row.accountNo}>
                    <td className="account-no">{row.accountNo}</td>
                    <td>{row.name || "—"}</td>
                    <td className="num">
                      {formatKroner(row.amount, currency)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
