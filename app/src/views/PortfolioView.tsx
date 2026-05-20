// Portfolio overview — one card per company, "needs attention" first.
//
// Deliberately juxtaposes the separate legal entities: it shows a count of
// companies and per-company figures, but never sums receivables/VAT across
// them, because they are distinct legal entities.

import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { sortByAttention } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { CompanyCard } from "../components/CompanyCard";
import { ErrorState, Loading } from "../components/Feedback";
import { Onboarding } from "./Onboarding";

export function PortfolioView() {
  const navigate = useNavigate();
  const state = useAsync(() => api.portfolio(), []);

  if (state.loading) return <Loading label="Henter portefølje…" />;
  if (state.error)
    return <ErrorState message={state.error} onRetry={state.reload} />;

  const portfolio = state.data!;

  // First run: an empty workspace drops straight into onboarding.
  if (portfolio.companies.length === 0) {
    return (
      <Onboarding
        onCreated={(slug) => navigate(`/companies/${slug}`)}
      />
    );
  }

  const ordered = sortByAttention(portfolio.companies);
  const needAttention = ordered.filter(
    (c) =>
      !c.archived &&
      (c.ledgerMissing ||
        !c.auditChainOk ||
        c.openExceptionCount > 0 ||
        c.overdueInvoiceCount > 0 ||
        c.unlinkedBankCount > 0),
  ).length;

  return (
    <section>
      <div className="page-head">
        <div>
          <h2>Portefølje</h2>
          <p className="muted">
            {portfolio.companyCount} virksomhed
            {portfolio.companyCount === 1 ? "" : "er"} · {needAttention} kræver
            opmærksomhed · pr. {portfolio.asOf}
          </p>
        </div>
        <Link className="btn" to="/companies/new">
          Tilføj virksomhed
        </Link>
      </div>

      <div className="company-grid">
        {ordered.map((c) => (
          <CompanyCard key={c.slug} company={c} />
        ))}
      </div>
    </section>
  );
}
