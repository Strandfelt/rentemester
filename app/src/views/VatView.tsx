// Moms — the per-company VAT return (cockpit-redesign iteration 3).
//
// Renders `/api/companies/:slug/vat?year=`: the VAT return for the quarter —
// output VAT (salgsmoms), input VAT (købsmoms), the resulting payable amount,
// AND the full SKAT TastSelv momsangivelse rubrics (rubrik A/B/C, foreign
// goods/services VAT) so the owner can file straight from the cockpit instead
// of dropping to the terminal (#257). All money fields are kroner —
// `formatKroner` is used throughout.

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatKroner } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import type { CompanyVat, VatRubrikker } from "../lib/types";
import { Banner, ErrorState, Loading } from "../components/Feedback";
import { CompanyNav, useCompanyYear } from "../components/CompanyNav";
import { ConfirmDialog } from "../components/ConfirmDialog";

export function VatView() {
  const { slug = "" } = useParams();
  const { year, setYear } = useCompanyYear();
  const state = useAsync<CompanyVat>(() => api.vat(slug, year), [slug, year]);
  // True while the close-period ConfirmDialog is open (#287).
  const [closing, setClosing] = useState(false);
  // Set after a successful period close — surfaced as a success banner.
  const [closedNotice, setClosedNotice] = useState<string | null>(null);

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
          {/* #287: closing the VAT quarter is the prerequisite for a
              momsangivelse — hidden for an archived (read-only) year. */}
          {!v.archived && (
            <button
              type="button"
              className="btn"
              onClick={() => setClosing(true)}
            >
              Luk momsperiode
            </button>
          )}
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

      {closedNotice && <Banner kind="success">{closedNotice}</Banner>}

      {closing && (
        <ConfirmDialog
          title="Luk momsperiode"
          body={
            <p>
              Luk momsperioden <strong>{v.periodLabel}</strong> ({v.periodStart}{" "}
              – {v.periodEnd}). En lukket periode er en forudsætning for at
              indberette momsangivelsen, og bogføring i perioden låses bagefter.
            </p>
          }
          confirmLabel="Luk perioden"
          confirmKind="danger"
          onConfirm={async () => {
            await api.closePeriod(slug, {
              periodStart: v.periodStart,
              periodEnd: v.periodEnd,
              kind: "vat_quarter",
            });
            setClosedNotice(
              `Momsperioden er lukket — ${v.periodLabel} kan nu indberettes.`,
            );
          }}
          onClose={() => setClosing(false)}
        />
      )}

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
                {/* A bad-debt write-off (debitortab) claims back the output
                    VAT on a receivable that will never be paid. It is shown
                    on its own line so it never silently turns the salgsmoms
                    headline above negative (#271). */}
                {v.outputVatAdjustment !== 0 && (
                  <tr>
                    <td>Regulering for tab på debitorer (debitortab)</td>
                    <td className="num">
                      {formatKroner(v.outputVatAdjustment, currency)}
                    </td>
                  </tr>
                )}
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

          <RubrikkerCard rubrikker={v.rubrikker} currency={currency} />

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
 * The full SKAT TastSelv momsangivelse rubrics — the exact numbers an owner
 * types into the momsangivelse on skat.dk. Surfacing these (#257) means the
 * cockpit's VAT view is filing-complete: rubrik A/B/C and the foreign
 * goods/services VAT no longer force a trip to the terminal's
 * `vat momsangivelse`. The figures are identical to the CLI's.
 */
function RubrikkerCard({
  rubrikker,
  currency,
}: {
  rubrikker: VatRubrikker;
  currency: string;
}) {
  const owedPositive = rubrikker.momstilsvar >= 0;
  return (
    <div className="card statement-card">
      <h3 className="statement-subhead">SKAT-rubrikker (momsangivelse)</h3>
      <p className="muted statement-note">
        De felter du udfylder i momsangivelsen på skat.dk (TastSelv Erhverv).
        Tallene er de samme, som <code>vat momsangivelse</code> i terminalen
        viser.
      </p>
      <table className="data statement-table">
        <tbody>
          <tr>
            <td>Salgsmoms</td>
            <td className="num">
              {formatKroner(rubrikker.salgsmoms, currency)}
            </td>
          </tr>
          <tr>
            <td>Moms af varekøb i udlandet (både EU og lande uden for EU)</td>
            <td className="num">
              {formatKroner(rubrikker.momsAfVarekobUdland, currency)}
            </td>
          </tr>
          <tr>
            <td>
              Moms af ydelseskøb i udlandet med omvendt betalingspligt
            </td>
            <td className="num">
              {formatKroner(rubrikker.momsAfYdelseskobUdland, currency)}
            </td>
          </tr>
          <tr>
            <td>Købsmoms</td>
            <td className="num">
              {formatKroner(rubrikker.kobsmoms, currency)}
            </td>
          </tr>
          <tr
            className={`statement-result ${
              owedPositive ? "positive" : "negative"
            }`}
          >
            <td>{owedPositive ? "Momstilsvar" : "Negativt momstilsvar"}</td>
            <td className="num">
              {formatKroner(rubrikker.momstilsvar, currency)}
            </td>
          </tr>
        </tbody>
      </table>
      <table className="data statement-table">
        <tbody>
          <tr>
            <td>Rubrik A — varer og ydelser købt i udlandet</td>
            <td className="num">
              {formatKroner(rubrikker.rubrikA, currency)}
            </td>
          </tr>
          <tr>
            <td>Rubrik B — varer og ydelser solgt til udlandet</td>
            <td className="num">
              {formatKroner(rubrikker.rubrikB, currency)}
            </td>
          </tr>
          <tr>
            <td>Rubrik C — øvrige momsfrie salg</td>
            <td className="num">
              {formatKroner(rubrikker.rubrikC, currency)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * The "X dage tilbage" countdown to the VAT filing deadline. Turns critical
 * once the deadline is near or passed, so an owner sees the urgency at a
 * glance — the quarterly momsangivelse is easy to forget.
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
