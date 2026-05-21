// Saldobalance — the per-company trial balance (cockpit-redesign iteration 2).
//
// Renders `/api/companies/:slug/trial-balance?year=`: a table of every account
// that moved in the year, with its summed debit total, credit total and the
// signed net balance. A totals row closes the table; the report is balanced
// when total debit equals total credit. All money fields are kroner.

import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatKroner } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import type { CompanyTrialBalance } from "../lib/types";
import { ErrorState, Loading } from "../components/Feedback";
import { CompanyNav, useCompanyYear } from "../components/CompanyNav";

export function TrialBalanceView() {
  const { slug = "" } = useParams();
  const { year, setYear } = useCompanyYear();
  const state = useAsync<CompanyTrialBalance>(
    () => api.trialBalance(slug, year),
    [slug, year],
  );

  if (state.loading && !state.data)
    return <Loading label="Henter saldobalance…" />;
  if (state.error)
    return <ErrorState message={state.error} onRetry={state.reload} />;

  const t = state.data!;
  const currency = t.company.currency || "DKK";

  return (
    <section className="statement">
      <div className="page-head">
        <div>
          <h2>{t.company.name}</h2>
          <p className="muted">
            {t.company.cvr ? `CVR ${t.company.cvr} · ` : ""}
            {t.company.country} · {currency} · Saldobalance
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
        years={t.fiscalYears}
        selectedYear={t.selectedYear}
        onYearChange={setYear}
      />

      {t.archived ? (
        <ArchivedNotice slug={slug} year={t.selectedYear} />
      ) : (
        <>
          <p className="statement-asof muted">
            {t.periodStart} – {t.periodEnd}
          </p>
          <div className="card statement-card table-scroll">
            <table className="data statement-table">
              <thead>
                <tr>
                  <th>Konto</th>
                  <th>Navn</th>
                  <th className="num">Debet</th>
                  <th className="num">Kredit</th>
                  <th className="num">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {t.rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="empty-inline">
                      Ingen posteringer i året.
                    </td>
                  </tr>
                ) : (
                  t.rows.map((row) => (
                    <tr key={row.accountNo}>
                      <td className="account-no">{row.accountNo}</td>
                      <td>{row.name}</td>
                      <td className="num">
                        {formatKroner(row.debit, currency)}
                      </td>
                      <td className="num">
                        {formatKroner(row.credit, currency)}
                      </td>
                      <td className="num">
                        {formatKroner(row.balance, currency)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="statement-subtotal">
                  <td colSpan={2}>I alt</td>
                  <td className="num">
                    {formatKroner(t.totalDebit, currency)}
                  </td>
                  <td className="num">
                    {formatKroner(t.totalCredit, currency)}
                  </td>
                  <td className="num" />
                </tr>
              </tfoot>
            </table>
          </div>
          <p className={`statement-check ${t.balanced ? "ok" : "alert"}`}>
            {t.balanced
              ? "Saldobalancen stemmer — debet = kredit."
              : "Saldobalancen stemmer ikke. Kontrollér ledgeren."}
          </p>
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
        Dette år ligger i det skrivebeskyttede arkiv. Den arkiverede
        saldobalance for {year} vises i Arkiv.
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
