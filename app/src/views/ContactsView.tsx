// Kontakter — the per-company customers and vendors (cockpit-redesign it. 5).
//
// Renders `/api/companies/:slug/contacts`: the master data — customers (kunder)
// and vendors (leverandører) — each in its own table with the key figures the
// ledger keys off (CVR, betalingsbetingelser, standardkonto). Contacts are not
// year-scoped, but the company sub-nav still carries the selected `?year=` so
// it follows the user across views — the fiscal years for the selector are
// fetched from the response. A company with no contacts shows a graceful
// empty state.

import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import type {
  CompanyContacts,
  ContactCustomerRow,
  ContactVendorRow,
} from "../lib/types";
import { ErrorState, Loading } from "../components/Feedback";
import { CompanyNav, useCompanyYear } from "../components/CompanyNav";

/** VAT-treatment codes from the ledger, mapped to a Danish label. */
const VAT_TREATMENT_LABELS: Record<string, string> = {
  standard: "Standardmoms",
  domestic_reverse_charge: "Omvendt betalingspligt (DK)",
  foreign_reverse_charge: "Omvendt betalingspligt (udland)",
  exempt: "Momsfritaget",
};

export function ContactsView() {
  const { slug = "" } = useParams();
  const { year, setYear } = useCompanyYear();
  const state = useAsync<CompanyContacts>(
    () => api.contacts(slug),
    [slug],
  );

  if (state.loading && !state.data)
    return <Loading label="Henter kontakter…" />;
  if (state.error)
    return <ErrorState message={state.error} onRetry={state.reload} />;

  const c = state.data!;
  const currency = c.company.currency || "DKK";
  const selectedYear =
    year ??
    c.fiscalYears.find((y) => y.source === "live")?.label ??
    c.fiscalYears[0]?.label ??
    String(new Date().getFullYear());
  const total = c.customers.length + c.vendors.length;

  return (
    <section className="statement">
      <div className="page-head">
        <div>
          <h2>{c.company.name}</h2>
          <p className="muted">
            {c.company.cvr ? `CVR ${c.company.cvr} · ` : ""}
            {c.company.country} · {currency} · Kontakter
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
        years={c.fiscalYears}
        selectedYear={selectedYear}
        onYearChange={setYear}
      />

      {total === 0 ? (
        <div className="card archived-notice">
          <h3>Ingen kontakter endnu</h3>
          <p className="muted">
            Der er ingen registrerede kunder eller leverandører for denne
            virksomhed. Kontakter oprettes som stamdata og vises her.
          </p>
        </div>
      ) : (
        <>
          <p className="statement-asof muted">
            {c.customers.length}{" "}
            {c.customers.length === 1 ? "kunde" : "kunder"} ·{" "}
            {c.vendors.length}{" "}
            {c.vendors.length === 1 ? "leverandør" : "leverandører"}
          </p>

          <div className="section">
            <h3>Kunder</h3>
            <CustomerTable customers={c.customers} />
          </div>

          <div className="section">
            <h3>Leverandører</h3>
            <VendorTable vendors={c.vendors} />
          </div>
        </>
      )}
    </section>
  );
}

function CustomerTable({ customers }: { customers: ContactCustomerRow[] }) {
  return (
    <div className="card statement-card table-scroll">
      <table className="data statement-table">
        <thead>
          <tr>
            <th>Navn</th>
            <th>CVR / moms-nr.</th>
            <th>E-mail</th>
            <th>Valuta</th>
            <th className="num">Betalingsfrist</th>
          </tr>
        </thead>
        <tbody>
          {customers.length === 0 ? (
            <tr>
              <td colSpan={5} className="empty-inline">
                Ingen kunder registreret.
              </td>
            </tr>
          ) : (
            customers.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td className="account-no">{row.vatOrCvr ?? "—"}</td>
                <td>{row.email ?? "—"}</td>
                <td>{row.defaultCurrency}</td>
                <td className="num">{row.paymentTermsDays} dage</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function VendorTable({ vendors }: { vendors: ContactVendorRow[] }) {
  return (
    <div className="card statement-card table-scroll">
      <table className="data statement-table">
        <thead>
          <tr>
            <th>Navn</th>
            <th>CVR / moms-nr.</th>
            <th>Standard udgiftskonto</th>
            <th>Momsbehandling</th>
          </tr>
        </thead>
        <tbody>
          {vendors.length === 0 ? (
            <tr>
              <td colSpan={4} className="empty-inline">
                Ingen leverandører registreret.
              </td>
            </tr>
          ) : (
            vendors.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td className="account-no">{row.vatOrCvr ?? "—"}</td>
                <td className="account-no">
                  {row.defaultExpenseAccount ?? "—"}
                </td>
                <td>
                  {row.defaultVatTreatment
                    ? VAT_TREATMENT_LABELS[row.defaultVatTreatment] ??
                      row.defaultVatTreatment
                    : "—"}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
