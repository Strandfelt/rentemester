// Per-company dashboard — native React render of /api/companies/:slug/dashboard.
//
// Mirrors the figures of the deterministic static HTML dashboard, but live and
// navigable. The static generator stays as the offline artifact; this is the
// interactive cockpit view.

import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatCurrency } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import type { CompanyDashboard } from "../lib/types";
import { ErrorState, Loading } from "../components/Feedback";

export function DashboardView() {
  const { slug = "" } = useParams();
  const state = useAsync(() => api.dashboard(slug), [slug]);

  if (state.loading) return <Loading label="Henter regnskab…" />;
  if (state.error)
    return <ErrorState message={state.error} onRetry={state.reload} />;

  const d = state.data!;
  const currency = d.company.currency || "DKK";

  return (
    <section>
      <div className="page-head">
        <div>
          <h2>{d.company.name}</h2>
          <p className="muted">
            {d.company.cvr ? `CVR ${d.company.cvr} · ` : ""}
            {d.company.country} · {currency} · pr. {d.asOf}
          </p>
        </div>
        <div className="row-actions">
          <Link className="btn secondary" to={`/companies/${slug}/manage`}>
            Administrér
          </Link>
          <Link className="btn secondary" to="/">
            Portefølje
          </Link>
        </div>
      </div>

      <div className="tiles">
        <Tile
          label="Åbne tilgodehavender"
          value={formatCurrency(d.invoices.openTotal, currency)}
          sub={`${d.invoices.count} åbne fakturaer`}
        />
        <Tile
          label="Forfaldne fakturaer"
          value={String(d.overdueInvoices.count)}
          tone={d.overdueInvoices.count > 0 ? "warn" : undefined}
        />
        <Tile
          label="Moms (kvartal)"
          value={formatCurrency(d.vat.netVatPayable, currency)}
          sub={`Frist om ${d.vat.daysRemaining} dage`}
          tone={d.vat.daysRemaining <= 14 ? "warn" : undefined}
        />
        <Tile
          label="Uafstemt bank"
          value={String(d.unlinkedBank.count)}
          tone={d.unlinkedBank.count > 0 ? "warn" : undefined}
        />
        <Tile
          label="Åbne undtagelser"
          value={String(d.exceptions.count)}
          tone={d.exceptions.count > 0 ? "alert" : undefined}
        />
        <Tile
          label="Revisionskæde"
          value={d.audit.ok ? "OK" : "Brudt"}
          sub={`${d.audit.entryCount} posteringer`}
          tone={d.audit.ok ? undefined : "alert"}
        />
        <Tile
          label="Seneste backup"
          value={backupValue(d)}
          sub={
            d.backup.hasActivitySinceBackup
              ? "Aktivitet siden seneste backup"
              : "Ingen ændringer siden backup"
          }
          tone={
            !d.backup.backupsFound || d.backup.hasActivitySinceBackup
              ? "warn"
              : undefined
          }
        />
      </div>

      <InvoiceSection
        title="Åbne fakturaer"
        rows={d.invoices.rows}
        currency={currency}
      />
      <InvoiceSection
        title="Forfaldne fakturaer"
        rows={d.overdueInvoices.rows}
        currency={currency}
      />
      <ExceptionsSection dashboard={d} />
      <ActivitySection dashboard={d} />
    </section>
  );
}

function backupValue(d: CompanyDashboard): string {
  if (!d.backup.backupsFound) return "Ingen";
  if (d.backup.daysSinceLatestBackup === null) return "Ukendt";
  const n = d.backup.daysSinceLatestBackup;
  if (n === 0) return "I dag";
  return `${n} dag${n === 1 ? "" : "e"} siden`;
}

function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "warn" | "alert";
}) {
  return (
    <div className={`tile${tone ? ` ${tone}` : ""}`}>
      <div className="t-label">{label}</div>
      <div className="t-value">{value}</div>
      {sub && <div className="t-sub">{sub}</div>}
    </div>
  );
}

function InvoiceSection({
  title,
  rows,
  currency,
}: {
  title: string;
  rows: CompanyDashboard["invoices"]["rows"];
  currency: string;
}) {
  return (
    <div className="section">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="empty-inline">Ingen.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Fakturanr.</th>
              <th>Kunde</th>
              <th>Forfald</th>
              <th className="num">Udestående</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.invoiceNumber}>
                <td>{r.invoiceNumber}</td>
                <td>{r.customerName ?? "—"}</td>
                <td>{r.dueDate ?? "—"}</td>
                <td className="num">
                  {formatCurrency(r.openBalance, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ExceptionsSection({ dashboard }: { dashboard: CompanyDashboard }) {
  const rows = dashboard.exceptions.rows;
  return (
    <div className="section">
      <h3>Åbne undtagelser</h3>
      {rows.length === 0 ? (
        <p className="empty-inline">Ingen åbne undtagelser.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Type</th>
              <th>Alvorlighed</th>
              <th>Besked</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td>{r.type}</td>
                <td>
                  <span
                    className={`flag ${
                      r.severity === "error" ? "critical" : "warning"
                    }`}
                  >
                    {r.severity}
                  </span>
                </td>
                <td>{r.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ActivitySection({ dashboard }: { dashboard: CompanyDashboard }) {
  const rows = dashboard.recentActivity;
  return (
    <div className="section">
      <h3>Seneste aktivitet</h3>
      {rows.length === 0 ? (
        <p className="empty-inline">Ingen registreret aktivitet endnu.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Tidspunkt</th>
              <th>Handling</th>
              <th>Beskrivelse</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{String(r.occurredAt ?? r.timestamp ?? "—")}</td>
                <td>{String(r.action ?? r.type ?? "—")}</td>
                <td>{String(r.summary ?? r.message ?? r.detail ?? "—")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
