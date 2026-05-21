// Bank — the per-company bank transactions (cockpit-redesign iteration 3).
//
// Renders `/api/companies/:slug/bank?year=`: the imported bank_transactions
// rows for the year — date, text, amount, running balance — each with its
// reconciliation status (matched vs unmatched to a posted journal entry). The
// registered bank account and its booked ledger balance are shown above the
// table. All money fields are kroner — `formatKroner` is used throughout.

import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatKroner } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import type { CompanyBank } from "../lib/types";
import { ErrorState, Loading } from "../components/Feedback";
import { CompanyNav, useCompanyYear } from "../components/CompanyNav";

export function BankView() {
  const { slug = "" } = useParams();
  const { year, setYear } = useCompanyYear();
  const state = useAsync<CompanyBank>(() => api.bank(slug, year), [slug, year]);

  if (state.loading && !state.data) return <Loading label="Henter bank…" />;
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
            {b.company.country} · {currency} · Bank
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
        <ArchivedNotice year={b.selectedYear} />
      ) : (
        <>
          <div className="status-grid bank-summary">
            <div className="card status-card">
              <h3>Bogført saldo</h3>
              <div className="status-figure">
                {formatKroner(b.bookedBalance, currency)}
              </div>
              <p className="muted status-note">
                {b.accounts.length > 0
                  ? b.accounts
                      .map((a) =>
                        [a.bankName, a.name].filter(Boolean).join(" · "),
                      )
                      .join(", ")
                  : "Bank- og kassekonti"}
              </p>
            </div>
            <div className="card status-card">
              <h3>Afstemning</h3>
              <div className="status-figure">
                {b.matchedCount} / {b.transactions.length}
              </div>
              <p className="muted status-note">
                {b.matchedCount} afstemt ·{" "}
                {b.unmatchedCount} uafstemte transaktioner
              </p>
            </div>
          </div>

          <div className="card statement-card table-scroll">
            <table className="data statement-table">
              <thead>
                <tr>
                  <th>Dato</th>
                  <th>Tekst</th>
                  <th className="num">Beløb</th>
                  <th className="num">Saldo</th>
                  <th>Afstemning</th>
                </tr>
              </thead>
              <tbody>
                {b.transactions.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="empty-inline">
                      Ingen banktransaktioner i året.
                    </td>
                  </tr>
                ) : (
                  b.transactions.map((tx) => (
                    <tr key={tx.id}>
                      <td className="entry-date">{tx.date}</td>
                      <td>{tx.text}</td>
                      <td className="num">
                        {formatKroner(tx.amount, currency)}
                      </td>
                      <td className="num">
                        {tx.runningBalance === null
                          ? "—"
                          : formatKroner(tx.runningBalance, currency)}
                      </td>
                      <td>
                        {tx.reconciliationStatus === "matched" ? (
                          <span className="flag ok">
                            Afstemt
                            {tx.journalEntryNo
                              ? ` · ${tx.journalEntryNo}`
                              : ""}
                          </span>
                        ) : (
                          <span className="flag warning">Uafstemt</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function ArchivedNotice({ year }: { year: string }) {
  return (
    <div className="card archived-notice">
      <h3>Regnskabsår {year} er arkiveret</h3>
      <p className="muted">
        Dette år ligger i det skrivebeskyttede arkiv. Banktransaktionerne for
        arkiverede år kommer i en senere udgave — se Arkiv.
      </p>
    </div>
  );
}
