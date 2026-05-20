// First-run onboarding. Shown when the workspace has no companies yet — it
// explains the cockpit's scope and presents the create-company form.

import { CompanyForm } from "../components/CompanyForm";

export function Onboarding({
  onCreated,
}: {
  onCreated: (slug: string) => void;
}) {
  return (
    <section>
      <div className="page-head">
        <div>
          <h2>Velkommen til Rentemester</h2>
          <p className="muted">
            Dit arbejdsområde er tomt. Opret din første virksomhed for at
            komme i gang.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <p className="muted" style={{ marginTop: 0 }}>
          Cockpittet er et kontrolpanel: du opretter og overvåger virksomheder
          her. Selve bogføringen — fakturaer, udgifter, moms — sker fortsat via
          agenten og kommandolinjen.
        </p>
      </div>

      <CompanyForm onCreated={onCreated} submitLabel="Opret første virksomhed" />
    </section>
  );
}
