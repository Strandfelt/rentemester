// Balance — the per-company balance sheet (cockpit-redesign iteration 2).
//
// Renders `/api/companies/:slug/balance?year=`: assets, liabilities and equity
// sections with section totals, as of the fiscal year's end date. The
// un-closed period result is shown on the equity side so the sheet balances
// (assets = liabilities + equity). All money fields are kroner.

import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatKroner } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import type { BalanceLine, CompanyBalance } from "../lib/types";
import { ErrorState, Loading } from "../components/Feedback";
import {
  CompanyNav,
  accountPostingsTo,
  useCompanyYear,
} from "../components/CompanyNav";

export function BalanceView() {
  const { slug = "" } = useParams();
  const { year, setYear } = useCompanyYear();
  const state = useAsync<CompanyBalance>(
    () => api.balance(slug, year),
    [slug, year],
  );

  if (state.loading && !state.data) return <Loading label="Henter balance…" />;
  if (state.error)
    return <ErrorState message={state.error} onRetry={state.reload} />;

  const b = state.data!;
  const currency = b.company.currency || "DKK";

  return (
    <section className="statement">
      <div className="page-head">
        <div>
          <h2>{b.company.name}</h2>
          <p className="muted">
            {b.company.cvr ? `CVR ${b.company.cvr} · ` : ""}
            {b.company.country} · {currency} · Balance
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
        years={b.fiscalYears}
        selectedYear={b.selectedYear}
        onYearChange={setYear}
      />

      {b.archived ? (
        <ArchivedNotice slug={slug} year={b.selectedYear} />
      ) : (
        <>
          <p className="statement-asof muted">Pr. {b.asOfDate}</p>
          <div className="card statement-card">
            <table className="data statement-table">
              <thead>
                <tr>
                  <th>Konto</th>
                  <th>Navn</th>
                  <th className="num">Beløb</th>
                </tr>
              </thead>
              <BalanceSection
                heading="Aktiver"
                lines={b.assets.lines}
                total={b.assets.total}
                totalLabel="Aktiver i alt"
                currency={currency}
                slug={slug}
                year={b.selectedYear}
              />
              <BalanceSection
                heading="Passiver"
                lines={b.liabilities.lines}
                total={b.liabilities.total}
                totalLabel="Gæld i alt"
                currency={currency}
                slug={slug}
                year={b.selectedYear}
              />
              <BalanceSection
                heading="Egenkapital"
                lines={b.equity.lines}
                total={b.equity.total}
                totalLabel="Egenkapital i alt"
                currency={currency}
                slug={slug}
                year={b.selectedYear}
                extraLabel="Årets resultat"
                extraAmount={b.periodResult}
              />
              <tbody>
                <tr className="statement-result">
                  <td colSpan={2}>Passiver og egenkapital i alt</td>
                  <td className="num">
                    {formatKroner(b.totalLiabilitiesAndEquity, currency)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <BalanceCheck balanced={b.balanced} />
        </>
      )}
    </section>
  );
}

function BalanceSection({
  heading,
  lines,
  total,
  totalLabel,
  currency,
  slug,
  year,
  extraLabel,
  extraAmount,
}: {
  heading: string;
  lines: BalanceLine[];
  total: number;
  totalLabel: string;
  currency: string;
  slug: string;
  year: string;
  /** An extra line appended after the accounts (e.g. the period result). */
  extraLabel?: string;
  extraAmount?: number;
}) {
  const hasExtra = extraLabel !== undefined && extraAmount !== undefined;
  const sectionTotal = hasExtra ? total + (extraAmount ?? 0) : total;
  return (
    <tbody>
      <tr className="statement-section-head">
        <th colSpan={3}>{heading}</th>
      </tr>
      {lines.length === 0 ? (
        <tr>
          <td colSpan={3} className="empty-inline">
            Ingen konti.
          </td>
        </tr>
      ) : (
        lines.map((line) => (
          <tr key={line.accountNo} className="account-row">
            <td className="account-no">
              <Link
                className="account-link"
                to={accountPostingsTo(slug, year, line.accountNo)}
              >
                {line.accountNo}
              </Link>
            </td>
            <td>{line.name}</td>
            <td className="num">{formatKroner(line.amount, currency)}</td>
          </tr>
        ))
      )}
      {hasExtra && (
        <tr>
          <td className="account-no">—</td>
          <td>{extraLabel}</td>
          <td className="num">{formatKroner(extraAmount ?? 0, currency)}</td>
        </tr>
      )}
      <tr className="statement-subtotal">
        <td colSpan={2}>{totalLabel}</td>
        <td className="num">{formatKroner(sectionTotal, currency)}</td>
      </tr>
    </tbody>
  );
}

function BalanceCheck({ balanced }: { balanced: boolean }) {
  return (
    <p className={`statement-check ${balanced ? "ok" : "alert"}`}>
      {balanced
        ? "Balancen stemmer — aktiver = passiver + egenkapital."
        : "Balancen stemmer ikke. Kontrollér ledgeren."}
    </p>
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
