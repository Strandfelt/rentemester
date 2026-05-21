// Fakturaer — the per-company issued invoices (cockpit-redesign iteration 5).
//
// Renders `/api/companies/:slug/invoices?year=`: the sales invoices issued in
// the selected fiscal year, each with its settlement status (kladde / bogført
// / betalt / forfalden …). Summary cards above the table give the year's gross
// total, the outstanding total and the overdue count. A company with no issued
// invoices shows a graceful empty state. All money fields are kroner —
// `formatKroner` is used throughout.

import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatKroner } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import type { CompanyInvoices, InvoiceStatus } from "../lib/types";
import { ErrorState, Loading } from "../components/Feedback";
import { CompanyNav, useCompanyYear } from "../components/CompanyNav";

/** Human label + flag tone for each settlement status. */
const STATUS_META: Record<
  InvoiceStatus,
  { label: string; tone: "ok" | "warning" | "critical" | "neutral" }
> = {
  open: { label: "Bogført", tone: "neutral" },
  paid: { label: "Betalt", tone: "ok" },
  credited: { label: "Krediteret", tone: "warning" },
  refunded: { label: "Refunderet", tone: "warning" },
  overpaid: { label: "Overbetalt", tone: "warning" },
  written_off: { label: "Afskrevet", tone: "critical" },
  overdue: { label: "Forfalden", tone: "critical" },
};

export function InvoicesView() {
  const { slug = "" } = useParams();
  const { year, setYear } = useCompanyYear();
  const state = useAsync<CompanyInvoices>(
    () => api.invoices(slug, year),
    [slug, year],
  );

  if (state.loading && !state.data)
    return <Loading label="Henter fakturaer…" />;
  if (state.error)
    return <ErrorState message={state.error} onRetry={state.reload} />;

  const inv = state.data!;
  const currency = inv.company.currency || "DKK";

  return (
    <section className="statement">
      <div className="page-head">
        <div>
          <h2>{inv.company.name}</h2>
          <p className="muted">
            {inv.company.cvr ? `CVR ${inv.company.cvr} · ` : ""}
            {inv.company.country} · {currency} · Fakturaer
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
        years={inv.fiscalYears}
        selectedYear={inv.selectedYear}
        onYearChange={setYear}
      />

      {inv.archived ? (
        <ArchivedNotice year={inv.selectedYear} />
      ) : inv.invoices.length === 0 ? (
        <div className="card archived-notice">
          <h3>Ingen fakturaer endnu</h3>
          <p className="muted">
            Der er ikke udstedt salgsfakturaer i regnskabsåret{" "}
            {inv.selectedYear}. Udstedte fakturaer vises her, så snart de er
            bogført.
          </p>
        </div>
      ) : (
        <>
          <div className="status-grid invoices-summary">
            <div className="card status-card">
              <h3>Faktureret i alt</h3>
              <div className="status-figure">
                {formatKroner(inv.totalGross, currency)}
              </div>
              <p className="muted status-note">
                {inv.invoices.length}{" "}
                {inv.invoices.length === 1 ? "faktura" : "fakturaer"} i{" "}
                {inv.selectedYear}
              </p>
            </div>
            <div className="card status-card">
              <h3>Udestående</h3>
              <div
                className={`status-figure${
                  inv.totalOpen > 0 ? " status-alert" : ""
                }`}
              >
                {formatKroner(inv.totalOpen, currency)}
              </div>
              <p className="muted status-note">
                {inv.overdueCount > 0
                  ? `${inv.overdueCount} forfalden${
                      inv.overdueCount === 1 ? "" : "e"
                    }`
                  : "Ingen forfaldne fakturaer"}
              </p>
            </div>
          </div>

          <div className="card statement-card table-scroll">
            <table className="data statement-table">
              <thead>
                <tr>
                  <th>Fakturanr.</th>
                  <th>Kunde</th>
                  <th>Dato</th>
                  <th>Forfald</th>
                  <th className="num">Beløb inkl. moms</th>
                  <th className="num">Udestående</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {inv.invoices.map((row) => {
                  const meta = STATUS_META[row.status];
                  return (
                    <tr key={row.documentId}>
                      <td className="account-no">{row.invoiceNo}</td>
                      <td>{row.customerName ?? "—"}</td>
                      <td className="entry-date">{row.invoiceDate ?? "—"}</td>
                      <td className="entry-date">
                        {row.effectiveDueDate ?? "—"}
                      </td>
                      <td className="num">
                        {formatKroner(row.grossAmount, currency)}
                      </td>
                      <td className="num">
                        {row.openBalance > 0
                          ? formatKroner(row.openBalance, currency)
                          : "—"}
                      </td>
                      <td>
                        <span className={`flag ${meta.tone}`}>
                          {meta.label}
                          {row.status === "overdue" && row.overdueDays > 0
                            ? ` · ${row.overdueDays} dage`
                            : ""}
                        </span>
                      </td>
                    </tr>
                  );
                })}
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
      <h3>Fakturaer er ikke tilgængelige for {year}</h3>
      <p className="muted">
        {year} er et arkiveret regnskabsår. Udstedte fakturaer føres kun i den
        aktive ledger og vises derfor ikke for et arkiveret år.
        Resultatopgørelse, balance, saldobalance og posteringer for {year} er
        tilgængelige.
      </p>
    </div>
  );
}
