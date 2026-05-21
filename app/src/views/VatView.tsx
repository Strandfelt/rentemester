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
        <ArchivedNotice year={v.selectedYear} />
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

          <div className="card statement-card vat-deadline">
            <div>
              <span className="vat-deadline-label">Angives og betales senest</span>
              <span className="vat-deadline-date">{v.deadline}</span>
            </div>
            <DeadlineCountdown days={v.daysRemaining} />
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

/**
 * The "X dage tilbage" countdown to the VAT filing deadline. Turns critical
 * once the deadline is near or passed, so an owner sees the urgency at a
 * glance — the half-yearly momsangivelse is easy to forget.
 */
function DeadlineCountdown({ days }: { days: number }) {
  if (days < 0) {
    return (
      <span className="flag critical">
        Fristen er overskredet {Math.abs(days)}{" "}
        {Math.abs(days) === 1 ? "dag" : "dage"}
      </span>
    );
  }
  if (days === 0) return <span className="flag critical">Frist i dag</span>;
  const tone = days <= 30 ? "warning" : "ok";
  return (
    <span className={`flag ${tone}`}>
      {days} {days === 1 ? "dag" : "dage"} tilbage
    </span>
  );
}

function ArchivedNotice({ year }: { year: string }) {
  return (
    <div className="card archived-notice">
      <h3>Moms er ikke tilgængelig for {year}</h3>
      <p className="muted">
        {year} er et arkiveret regnskabsår. Momsopgørelsen beregnes fra den
        aktive ledgers bogførte momskonti, og en momsangivelse kan ikke
        rekonstrueres for et arkiveret år — den vises derfor ikke.
        Resultatopgørelse, balance, saldobalance og posteringer for {year} er
        tilgængelige.
      </p>
    </div>
  );
}
