// Posteringer — the per-company journal (cockpit-redesign iteration 3).
//
// Renders `/api/companies/:slug/journal?year=`: the posted journal entries for
// the year (entry no, date, text, total). Clicking an entry expands it to show
// its debit/credit lines (account no + name, debit, credit). All money fields
// are kroner — `formatKroner` is used throughout.

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatKroner } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import type { CompanyJournal, JournalEntry } from "../lib/types";
import { ErrorState, Loading } from "../components/Feedback";
import { CompanyNav, useCompanyYear } from "../components/CompanyNav";

export function JournalView() {
  const { slug = "" } = useParams();
  const { year, setYear } = useCompanyYear();
  const state = useAsync<CompanyJournal>(
    () => api.journal(slug, year),
    [slug, year],
  );

  if (state.loading && !state.data)
    return <Loading label="Henter posteringer…" />;
  if (state.error)
    return <ErrorState message={state.error} onRetry={state.reload} />;

  const j = state.data!;
  const currency = j.company.currency || "DKK";

  return (
    <section className="statement">
      <div className="page-head">
        <div>
          <h2>{j.company.name}</h2>
          <p className="muted">
            {j.company.cvr ? `CVR ${j.company.cvr} · ` : ""}
            {j.company.country} · {currency} · Posteringer
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
        years={j.fiscalYears}
        selectedYear={j.selectedYear}
        onYearChange={setYear}
      />

      {j.archived ? (
        <ArchivedNotice year={j.selectedYear} />
      ) : (
        <>
          <p className="statement-asof muted">
            {j.periodStart} – {j.periodEnd} · {j.entries.length} posteringer
          </p>
          {j.entries.length === 0 ? (
            <div className="card statement-card">
              <p className="empty-inline" style={{ padding: "var(--space-md)" }}>
                Ingen posteringer i året.
              </p>
            </div>
          ) : (
            <ul className="entry-list">
              {j.entries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} currency={currency} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function EntryRow({
  entry,
  currency,
}: {
  entry: JournalEntry;
  currency: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`entry-item${open ? " open" : ""}`}>
      <button
        type="button"
        className="entry-summary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="entry-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="entry-no">{entry.entryNo}</span>
        <span className="entry-date">{entry.date}</span>
        <span className="entry-text">{entry.text}</span>
        <span className="entry-total num">
          {formatKroner(entry.total, currency)}
        </span>
      </button>
      {open && (
        <div className="entry-lines table-scroll">
          <table className="data statement-table">
            <thead>
              <tr>
                <th>Konto</th>
                <th>Navn</th>
                <th className="num">Debet</th>
                <th className="num">Kredit</th>
              </tr>
            </thead>
            <tbody>
              {entry.lines.map((line, i) => (
                <tr key={i}>
                  <td className="account-no">{line.accountNo}</td>
                  <td>
                    {line.accountName}
                    {line.text ? (
                      <span className="muted"> · {line.text}</span>
                    ) : null}
                  </td>
                  <td className="num">
                    {line.debit ? formatKroner(line.debit, currency) : "—"}
                  </td>
                  <td className="num">
                    {line.credit ? formatKroner(line.credit, currency) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}

function ArchivedNotice({ year }: { year: string }) {
  return (
    <div className="card archived-notice">
      <h3>Regnskabsår {year} er arkiveret</h3>
      <p className="muted">
        Dette år ligger i det skrivebeskyttede arkiv. Posteringerne for
        arkiverede år kommer i en senere udgave — se Arkiv.
      </p>
    </div>
  );
}
