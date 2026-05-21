// BankImportModal — the human bank-CSV-import action for the Cockpit (#213, slice 2).
//
// A person opens this from the Bank view, picks a bank-statement CSV file, and
// (optionally) names a bank account or import profile. The browser reads the
// file text and POSTs it; the server writes it to a temp file and runs the
// same `importBankCsv` core function the CLI and MCP use.
//
// The modal owns the file picker, the busy state and inline error/lock
// rendering — it mirrors `ConfirmDialog`'s shape (which only carries a note
// field, so it cannot be reused directly for a file upload) and reuses the
// shared `LockBanner` for a 409 backup-lock rejection.

import { useEffect, useRef, useState } from "react";
import { api, type BankImportSummary } from "../lib/api";
import { Banner } from "./Feedback";
import { LockBanner } from "./LockBanner";

/** Shape of the API error the cockpit's `api.ts` throws. */
type MaybeApiError = { code?: string; message?: string };

export type BankImportModalProps = {
  /** Company slug the import targets. */
  slug: string;
  /** Re-runs the Bank view load after a successful import. */
  onImported: () => void;
  /** Closes the modal without acting. */
  onClose: () => void;
};

export function BankImportModal({ slug, onImported, onClose }: BankImportModalProps) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvContent, setCsvContent] = useState<string | null>(null);
  const [account, setAccount] = useState("");
  const [profile, setProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const [done, setDone] = useState<BankImportSummary | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Move focus into the dialog and let Escape dismiss it — basic modal hygiene.
  useEffect(() => {
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setError(null);
    if (!file) {
      setFileName(null);
      setCsvContent(null);
      return;
    }
    try {
      const text = await file.text();
      setFileName(file.name);
      setCsvContent(text);
    } catch {
      setError("Filen kunne ikke læses.");
      setFileName(null);
      setCsvContent(null);
    }
  }

  async function handleImport() {
    if (!csvContent) {
      setError("Vælg en CSV-fil først.");
      return;
    }
    setBusy(true);
    setError(null);
    setLocked(null);
    try {
      const summary = await api.importBank(slug, {
        csvContent,
        account: account.trim() || undefined,
        profile: profile.trim() || undefined,
      });
      setDone(summary);
      onImported();
    } catch (err) {
      const e = err as MaybeApiError;
      const message = e?.message ?? "Importen kunne ikke gennemføres.";
      // A 409 conflict from the backup lock is shown kindly, not as an error.
      if (e?.code === "conflict") setLocked(message);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Importér kontoudtog"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal-title">Importér kontoudtog</h3>

        {done ? (
          // After a successful import the modal becomes a short receipt.
          <>
            <div className="modal-body">
              <p>
                {done.imported}{" "}
                {done.imported === 1 ? "transaktion" : "transaktioner"}{" "}
                importeret
                {done.skippedDuplicates > 0
                  ? ` · ${done.skippedDuplicates} dublet${
                      done.skippedDuplicates === 1 ? "" : "ter"
                    } sprunget over`
                  : ""}
                {done.exceptionsCreated > 0
                  ? ` · ${done.exceptionsCreated} ny${
                      done.exceptionsCreated === 1 ? "" : "e"
                    } opgave${done.exceptionsCreated === 1 ? "" : "r"}`
                  : ""}
                .
              </p>
            </div>
            {done.balanceWarnings.length > 0 && (
              <Banner kind="warning">
                {done.balanceWarnings.join(" ")}
              </Banner>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                ref={closeRef}
                onClick={onClose}
              >
                Luk
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="modal-body">
              <p>
                Vælg en bank-CSV. Transaktionerne lægges i regnskabet — dubletter
                springes automatisk over. Uafstemte transaktioner bliver til
                opgaver.
              </p>
            </div>

            {locked && <LockBanner message={locked} />}
            {error && <Banner kind="error">{error}</Banner>}

            <label className="modal-field">
              CSV-fil
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={handleFile}
                disabled={busy}
              />
            </label>
            {fileName && (
              <p className="muted" style={{ margin: 0 }}>
                Valgt: {fileName}
              </p>
            )}

            <label className="modal-field">
              Bankkonto (valgfri)
              <input
                type="text"
                value={account}
                placeholder="Konto-id eller slug"
                onChange={(e) => setAccount(e.target.value)}
                disabled={busy}
              />
            </label>

            <label className="modal-field">
              Importprofil (valgfri)
              <input
                type="text"
                value={profile}
                placeholder="fx danske-bank"
                onChange={(e) => setProfile(e.target.value)}
                disabled={busy}
              />
            </label>

            <div className="modal-actions">
              <button
                type="button"
                className="btn secondary"
                onClick={onClose}
                disabled={busy}
              >
                Annullér
              </button>
              <button
                type="button"
                className="btn"
                onClick={handleImport}
                disabled={busy || !csvContent}
              >
                {busy ? "Importerer…" : "Importér"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
