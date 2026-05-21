// Moms — the per-company VAT return (cockpit-redesign iteration 3).
//
// Renders `/api/companies/:slug/vat?year=`: the VAT return for the period —
// output VAT (salgsmoms), input VAT (købsmoms) and the resulting payable
// amount, with the period label. All money fields are kroner — `formatKroner`
// is used throughout.

import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatKroner } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import type { CompanyVat } from "../lib/types";
import { ErrorState, Loading } from "../components/Feedback";
import { CompanyNav, useCompanyYear } from "../components/CompanyNav";

export function VatView() {
  const { slug = "" } = useParams();
  const { year, setYear } = useCompanyYear();
  const state = useAsync<CompanyVat>(() => api.vat(slug, year), [slug, year]);

  if (state.loading && !state.data) return <Loading label="Henter moms…" />;
  if (state.error)
    return <ErrorState message={state.error} onRetry={state.reload} />;

  const v = state.data!;
  const currency = v.company.currency || "DKK";
  const payablePositive = v.payable >= 0;

  return (
    <section className="statement">
      <div className="page-head">
        <div>
          <h2>{v.company.name}</h2>
          <p className="muted">
            {v.company.cvr ? `CVR ${v.company.cvr} · ` : ""}
            {v.company.country} · {currency} · Moms
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
        years={v.fiscalYears}
        selectedYear={v.selectedYear}
        onYearChange={setYear}
      />

      {v.archived ? (
        <ArchivedNotice slug={slug} year={v.selectedYear} />
      ) : (
        <>
          <p className="statement-asof muted">
            {v.periodLabel} · {v.periodStart} – {v.periodEnd}
          </p>
          <div className="card statement-card">
            <table className="data statement-table">
              <tbody>
                <tr>
                  <td>Salgsmoms (udgående moms)</td>
                  <td className="num">
                    {formatKroner(v.outputVat, currency)}
                  </td>
                </tr>
                <tr>
                  <td>Købsmoms (indgående moms)</td>
                  <td className="num">
                    {formatKroner(v.inputVat, currency)}
                  </td>
                </tr>
                <tr
                  className={`statement-result ${
                    payablePositive ? "positive" : "negative"
                  }`}
                >
                  <td>{payablePositive ? "Moms at betale" : "Moms tilgode"}</td>
                  <td className="num">{formatKroner(v.payable, currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="statement-check ok">
            {payablePositive
              ? "Salgsmoms minus købsmoms — beløbet skal afregnes til SKAT."
              : "Købsmoms overstiger salgsmoms — beløbet udbetales fra SKAT."}
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
        Dette år ligger i det skrivebeskyttede arkiv. De arkiverede data for
        {" "}
        {year} vises i Arkiv.
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
