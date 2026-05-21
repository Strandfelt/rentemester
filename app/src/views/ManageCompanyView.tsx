// Company management — rename the display name, sync CVR stamdata, and
// archive/restore.
//
// Strictly non-destructive: there is intentionally no delete of ledger data.
// Archiving only flips a manifest flag; the ledger stays on disk untouched.

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { Banner, ErrorState, Loading } from "../components/Feedback";
import type { CompanyEntry, CompanySettings } from "../lib/types";

export function ManageCompanyView() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const state = useAsync(async () => {
    const companies = await api.companies();
    const found = companies.find((c) => c.slug === slug);
    if (!found) throw new ApiError("not_found", "Virksomheden findes ikke.", 404);
    const settings = await api.companySettings(slug);
    return { found, settings };
  }, [slug]);

  if (state.loading) return <Loading />;
  if (state.error)
    return <ErrorState message={state.error} onRetry={state.reload} />;

  return (
    <ManageForm
      company={state.data!.found}
      settings={state.data!.settings}
      onArchivedAway={() => navigate("/")}
    />
  );
}

function ManageForm({
  company,
  settings,
  onArchivedAway,
}: {
  company: CompanyEntry;
  settings: CompanySettings;
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

      <CvrCard slug={company.slug} initial={settings} />

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

/**
 * The CVR-stamdata card: shows the company's registered address / branche /
 * status and a "Hent fra CVR" button that refreshes it from the CVR register.
 * The lookup runs server-side, so the CVR credentials never reach the browser.
 */
function CvrCard({ slug, initial }: { slug: string; initial: CompanySettings }) {
  const [settings, setSettings] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fiscalWarning, setFiscalWarning] = useState<string | null>(null);

  const hasCvr = Boolean(settings.cvr);

  async function sync() {
    setBusy(true);
    setError(null);
    setNotice(null);
    setFiscalWarning(null);
    try {
      const result = await api.syncCvr(slug);
      if (!result.ok) {
        setError(result.errors[0] ?? "CVR-opslaget mislykkedes.");
        return;
      }
      const fresh = await api.companySettings(slug);
      setSettings(fresh);
      const changed = result.updatedFields ?? [];
      setNotice(
        changed.length > 0
          ? `Hentet fra CVR. Opdaterede felter: ${changed.join(", ")}.`
          : "Hentet fra CVR. Stamdata var allerede opdateret.",
      );
      const fy = result.fiscalYearStartMonth;
      if (fy && !fy.matches && fy.cvr !== null) {
        setFiscalWarning(
          `CVR har regnskabsår der starter i måned ${fy.cvr}, men virksomheden ` +
            `er sat op med måned ${fy.current}. Regnskabsåret ændres aldrig ` +
            `automatisk — ret det manuelt hvis det er forkert.`,
        );
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kunne ikke hente fra CVR.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 24, maxWidth: 460 }}>
      <h3 style={{ marginTop: 0 }}>CVR-stamdata</h3>

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="success">{notice}</Banner>}
      {fiscalWarning && <Banner kind="warning">{fiscalWarning}</Banner>}

      {!hasCvr && (
        <p className="muted">
          Der er ikke registreret et CVR-nummer på virksomheden. Tilføj et
          CVR-nummer for at kunne hente stamdata fra CVR-registret.
        </p>
      )}

      {hasCvr && (
        <dl className="cvr-facts">
          <Fact label="CVR-nummer" value={settings.cvr} />
          <Fact label="Adresse" value={cvrAddressLine(settings)} />
          <Fact label="Virksomhedsform" value={settings.companyForm} />
          <Fact
            label="Branche"
            value={
              settings.industryText && settings.industryCode
                ? `${settings.industryCode} — ${settings.industryText}`
                : settings.industryText
            }
          />
          <Fact label="Status" value={settings.cvrStatus} />
          <Fact
            label="Revision fravalgt"
            value={
              settings.auditWaived === null
                ? null
                : settings.auditWaived
                  ? "Ja"
                  : "Nej"
            }
          />
          <Fact
            label="Sidst hentet"
            value={settings.cvrSyncedAt ? settings.cvrSyncedAt.slice(0, 10) : "Aldrig"}
          />
        </dl>
      )}

      <button className="btn secondary" onClick={sync} disabled={busy || !hasCvr}>
        {busy ? "Henter…" : "Hent fra CVR"}
      </button>
      <p className="field-hint">
        Kræver at serveren har CVR_USERNAME og CVR_PASSWORD sat. Regnskabsåret
        ændres aldrig automatisk.
      </p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="cvr-fact">
      <dt className="muted">{label}</dt>
      <dd>{value && value.length > 0 ? value : "—"}</dd>
    </div>
  );
}

function cvrAddressLine(settings: CompanySettings): string | null {
  const cityLine = [settings.postalCode, settings.city].filter(Boolean).join(" ");
  const full = [settings.address, cityLine].filter((p) => p && p.length > 0).join(", ");
  return full.length > 0 ? full : null;
}
