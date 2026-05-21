// Flerårsoversigt — a multi-year comparison (cockpit-redesign iteration 4).
//
// Renders `/api/companies/:slug/multi-year`: key figures (omsætning / udgifter
// / resultat) for every fiscal year a company has — live ledger years and the
// read-only #197 archive years alike — as both a comparison table and a
// Chart.js trend chart. This is the "se flere regnskabsår samtidig" view. All
// money fields are kroner — `formatKroner` is used throughout.

import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatKroner } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import type { CompanyMultiYear } from "../lib/types";
import { ErrorState, Loading } from "../components/Feedback";
import { CompanyNav, useCompanyYear } from "../components/CompanyNav";
import { MultiYearChart } from "../components/MultiYearChart";

export function MultiYearView() {
  const { slug = "" } = useParams();
  const { setYear } = useCompanyYear();
  const state = useAsync<CompanyMultiYear>(
    () => api.multiYear(slug),
    [slug],
  );

  if (state.loading && !state.data)
    return <Loading label="Henter flerårsoversigt…" />;
  if (state.error)
    return <ErrorState message={state.error} onRetry={state.reload} />;

  const m = state.data!;
  const currency = m.company.currency || "DKK";
  // The fiscal-year selector is shown for consistency with the other views;
  // newest-first like everywhere else. The Flerårsoversigt itself shows every
  // year, so the selected year only routes the other views.
  const selectorYears = [...m.years]
    .map((y) => ({
      label: y.year,
      start: null,
      end: null,
      source: y.source,
    }))
    .sort((a, b) => b.label.localeCompare(a.label));
  const selectedYear = selectorYears[0]?.label ?? "";

  return (
    <section className="statement">
      <div className="page-head">
        <div>
          <h2>{m.company.name}</h2>
          <p className="muted">
            {m.company.cvr ? `CVR ${m.company.cvr} · ` : ""}
            {m.company.country} · {currency} · Flerårsoversigt
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
        years={selectorYears}
        selectedYear={selectedYear}
        onYearChange={setYear}
      />

      {m.years.length === 0 ? (
        <div className="card archived-notice">
          <h3>Ingen regnskabsår</h3>
          <p className="muted">
            Denne virksomhed har endnu ingen bogførte eller arkiverede
            regnskabsår at sammenligne.
          </p>
        </div>
      ) : (
        <>
          <div className="section">
            <h3>Udvikling — omsætning, udgifter og resultat</h3>
            <div className="card chart-card">
              <MultiYearChart years={m.years} />
            </div>
          </div>

          <div className="section">
            <h3>Nøgletal pr. regnskabsår</h3>
            <div className="card statement-card table-scroll">
              <table className="data statement-table">
                <thead>
                  <tr>
                    <th>Regnskabsår</th>
                    <th className="num">Omsætning</th>
                    <th className="num">Udgifter</th>
                    <th className="num">Resultat</th>
                  </tr>
                </thead>
                <tbody>
                  {m.years.map((y) => (
                    <tr key={y.year}>
                      <td>
                        {y.year}
                        {y.source === "archive" ? (
                          <span className="flag warning archive-tag">
                            arkiv
                          </span>
                        ) : null}
                      </td>
                      <td className="num">
                        {formatKroner(y.omsaetning, currency)}
                      </td>
                      <td className="num">
                        {formatKroner(y.udgifter, currency)}
                      </td>
                      <td
                        className={`num ${
                          y.resultat >= 0 ? "amount-positive" : "amount-negative"
                        }`}
                      >
                        {formatKroner(y.resultat, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
