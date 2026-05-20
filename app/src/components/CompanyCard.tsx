// One company in the portfolio overview. Renders the at-a-glance metrics and
// the derived "needs attention" flags; links into the per-company dashboard.

import { Link } from "react-router-dom";
import type { CompanySummary } from "../lib/types";
import { attentionFlags, attentionLevel, formatCurrency } from "../lib/format";

export function CompanyCard({ company }: { company: CompanySummary }) {
  const level = attentionLevel(company);
  const flags = attentionFlags(company);

  return (
    <article
      className={`company-card level-${level}${company.archived ? " archived" : ""}`}
    >
      <div className="cc-head">
        <div>
          <h3>
            <Link to={`/companies/${company.slug}`}>{company.name}</Link>
          </h3>
          <div className="cc-cvr">
            {company.cvr ? `CVR ${company.cvr}` : "CVR ikke angivet"}
          </div>
        </div>
        {company.archived && <span className="badge">Arkiveret</span>}
      </div>

      {company.ledgerMissing ? (
        <p className="empty-inline">
          Virksomheden er registreret, men har endnu intet regnskab på disken.
        </p>
      ) : (
        <div className="metric-row">
          <div className="metric">
            <span className="m-label">Åbne tilgodehavender</span>
            <span className="m-value">
              {formatCurrency(company.openInvoiceTotal)}
            </span>
          </div>
          <div className="metric">
            <span className="m-label">Moms for kvartalet</span>
            <span className="m-value">
              {formatCurrency(company.netVatPayable)}
            </span>
          </div>
          <div className="metric">
            <span className="m-label">Åbne fakturaer</span>
            <span className="m-value">{company.openInvoiceCount}</span>
          </div>
          <div className="metric">
            <span className="m-label">Revisionskæde</span>
            <span className="m-value">
              {company.auditChainOk ? "OK" : "Brudt"}
            </span>
          </div>
        </div>
      )}

      <div className="flags">
        {flags.length === 0 ? (
          <span className="flag ok">Ingen åbne punkter</span>
        ) : (
          flags.map((f) => (
            <span key={f.label} className={`flag ${f.level}`}>
              {f.label}
            </span>
          ))
        )}
      </div>
    </article>
  );
}
