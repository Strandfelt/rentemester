// Company management — rename the display name and archive/restore.
//
// Strictly non-destructive: there is intentionally no delete of ledger data.
// Archiving only flips a manifest flag; the ledger stays on disk untouched.

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { Banner, ErrorState, Loading } from "../components/Feedback";
import type { CompanyEntry } from "../lib/types";

export function ManageCompanyView() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const state = useAsync(async () => {
    const companies = await api.companies();
    const found = companies.find((c) => c.slug === slug);
    if (!found) throw new ApiError("not_found", "Virksomheden findes ikke.", 404);
    return found;
  }, [slug]);

  if (state.loading) return <Loading />;
  if (state.error)
    return <ErrorState message={state.error} onRetry={state.reload} />;

  return (
    <ManageForm
      company={state.data!}
      onArchivedAway={() => navigate("/")}
    />
  );
}

function ManageForm({
  company,
  onArchivedAway,
}: {
  company: CompanyEntry;
  onArchivedAway: () => void;
}) {
  const [name, setName] = useState(company.name);
  // Local mirrors of the persisted state, so the form stays consistent after a
  // save without re-fetching (a re-fetch would unmount this form mid-notice).
  const [savedName, setSavedName] = useState(company.name);
  const [archived, setArchived] = useState(company.archived);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const renameDisabled =
    busy || name.trim().length === 0 || name.trim() === savedName;

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.updateCompany(company.slug, {
        name: name.trim(),
      });
      setSavedName(updated.name);
      setName(updated.name);
      setNotice("Visningsnavn opdateret.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kunne ikke gemme navnet.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    const next = !archived;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.updateCompany(company.slug, { archived: next });
      if (next) {
        onArchivedAway();
      } else {
        setArchived(false);
        setNotice("Virksomheden er gendannet.");
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Kunne ikke ændre arkivstatus.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h2>Administrér {savedName}</h2>
          <p className="muted">
            Slug <code>{company.slug}</code> · oprettet{" "}
            {company.createdAt.slice(0, 10)}
            {archived ? " · arkiveret" : ""}
          </p>
        </div>
        <Link className="btn secondary" to={`/companies/${company.slug}`}>
          Tilbage til regnskab
        </Link>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="success">{notice}</Banner>}

      <form className="form" onSubmit={rename} aria-label="Omdøb virksomhed">
        <label>
          Visningsnavn
          <input
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <span className="field-hint">
            Ændrer kun det viste navn — slug og regnskabsdata berøres ikke.
          </span>
        </label>
        <div className="row-actions">
          <button className="btn" type="submit" disabled={renameDisabled}>
            Gem navn
          </button>
        </div>
      </form>

      <div className="card" style={{ marginTop: 24, maxWidth: 460 }}>
        <h3 style={{ marginTop: 0 }}>
          {archived ? "Gendan virksomhed" : "Arkivér virksomhed"}
        </h3>
        <p className="muted">
          {archived
            ? "Virksomheden er arkiveret. Gendan den for at vise den i porteføljen igen."
            : "Arkivering skjuler virksomheden fra den aktive portefølje. Regnskabsdata slettes aldrig og kan gendannes."}
        </p>
        <button className="btn secondary" onClick={toggleArchive} disabled={busy}>
          {archived ? "Gendan virksomhed" : "Arkivér virksomhed"}
        </button>
      </div>
    </section>
  );
}
