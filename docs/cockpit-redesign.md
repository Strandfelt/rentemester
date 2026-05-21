# Cockpit-redesign — byggeplan & to-do

Arbejds- og to-do-liste for ombygningen af Cockpit-webappen (`app/` + `src/server/`).
Listen loopes: hver iteration bygges af en underagent, og **hver runde slutter med en
visuel inspektion** før næste.

## Mål

Cockpit skal give et menneske et hurtigt, præcist og flot overblik over en
virksomheds regnskab. To krav over alt andet:

1. **Korrekthed.** Alle tal afspejler præcist det bogførte i ledgeren. Ledgeren er
   sandheden — cockpittet beregner og viser, det opfinder ikke.
2. **Informationsparitet med Dinero.** Vi skal som minimum kunne vise det Dinero
   viser (overblik, resultat, balance, moms, bank, posteringer, kontakter).
   Visuelt behøver vi ikke ligne dem — informationsmæssigt skal vi ramme dem.

## Principper

- **Flot** — roligt, professionelt; følger `DESIGN.md`-tokens.
- **Overskueligt** — overblik på fem sekunder; progressiv detalje (drill-down).
- **Responsivt** — fungerer og ser godt ud på både desktop og mobil.
- **Grafer** — nøgletal og udvikling visualiseres (Chart.js).
- **Multi-år** — man kan vælge regnskabsår, se flere år, og sammenligne år.
- **Visuel inspektion hver runde** — screenshot (desktop + mobil), tal verificeret
  mod ground truth, design vurderet, før næste iteration.

## Datagrundlag

- **Live ledger** = indeværende regnskabsår (Helheim: 2026).
- **Arkiv (#197)** = tidligere år (Helheim: 2023, 2024, 2025) — read-only.
- Cockpittet skal læse begge, så alle regnskabsår er tilgængelige i UI'et.

## Ground truth (Helheim ApS, regnskabsår 2026) — målestok for korrekthed

- Omsætning **17.829,02** · Udgifter **4.594,20** · Resultat **13.234,82**
- Moms 1. halvår 2026: **3.371,00** at betale (salgsmoms 4.457, købsmoms 1.148)
- Bogført bankkonto-saldo (konto 55000)
- 5 købsbilag, 0 salgsfakturaer

## Views

| # | View | Formål | Dinero-pendant | Prioritet |
|---|------|--------|----------------|-----------|
| 1 | Portefølje | Virksomhedsliste (workspace) | — | findes, let polish |
| 2 | Overblik | Nøgletal + grafer + statuskort | "Overblik" | **P0** |
| 3 | Resultatopgørelse | Indtægter, udgifter, resultat | — | P1 |
| 4 | Balance | Aktiver, passiver, egenkapital | — | P1 |
| 5 | Saldobalance | Alle konti med saldo | — | P1 |
| 6 | Posteringer | Journal/bilagsliste + drill-down til linjer | "Bilagsoversigt" | P1 |
| 7 | Bank | Banktransaktioner + afstemningsstatus | "Bankafstemning" | P2 |
| 8 | Moms | Momsangivelse for perioden | "Moms" | P2 |
| 9 | Bilag | Dokumenter/kvitteringer + link til posteringer | — | P2 |
| 10 | Arkiv | Tidligere år (2023–25), read-only | — | P2 |
| 11 | Flerårsoversigt | Flere regnskabsår sammenlignet | — | P3 |
| 12 | Fakturaer | Udstedte fakturaer + status | "Salg" | P3 |
| 13 | Kontakter | Kunder + leverandører | "Kontakter" | P3 |

## Backend (API)

Nuværende endpoints: `/api/health`, `/api/portfolio`, `/api/companies`,
`/api/companies/:slug` (PATCH), `/api/companies/:slug/dashboard`.

Nye/udvidede endpoints — alle årsbevidste (`?year=YYYY`), genbruger `src/core/`:

- `/api/companies/:slug/fiscal-years` — tilgængelige år (live + arkiverede)
- `/api/companies/:slug/overview?year=` — Overblik: resultat-sammendrag, bank, moms, undtagelser, seneste posteringer
- `/api/companies/:slug/income-statement?year=`
- `/api/companies/:slug/balance?year=`
- `/api/companies/:slug/trial-balance?year=`
- `/api/companies/:slug/journal?year=` — posteringer/bilag
- `/api/companies/:slug/bank?year=`
- `/api/companies/:slug/vat?year=&period=`
- `/api/companies/:slug/documents`
- `/api/companies/:slug/invoices`
- `/api/companies/:slug/contacts`
- `/api/companies/:slug/archive/:year` — arkiveret år (#197-data)
- `/api/companies/:slug/multi-year` — nøgletal på tværs af år

## Tværgående

- **Regnskabsårs-vælger** — global kontrol; alle views respekterer det valgte år.
- **Chart.js** — tilføjes til `app/`; bruges til P&L-graf og flerårs-trends.
- **Responsivt layout** — desktop + mobil.
- **Designsystem** — tokens i `app/src/styles.css` ud fra `DESIGN.md`.

## Loop-protokol

Hver runde: underagent bygger iterationens opgaver på `feat/cockpit-redesign`
→ jeg screenshotter den kørende app (desktop **og** mobil) → jeg verificerer tal
mod ground truth → vurderer design mod principperne → skriver konkret feedback
→ næste runde. Afkryds opgaver herunder efterhånden som de er inspiceret og godkendt.

## To-do

### Iteration 0 — Diagnose, ledger-fix & fundament

**Diagnose-fund (kritisk):** Helheim-ledgeren er fejlklassificeret. Dinero-importen
(#193) lader eksisterende konti i Rentemesters seedede kontoplan stå urørt — så
Dineros konti, der kolliderer på kontonummer, bliver IKKE anvendt. Konkret:
Dineros `2000 Vareforbrug` (udgift) kolliderer med Rentemesters seedede `2000 Bank`
(aktiv), så 4.113,04 kr vareforbrug er bogført på en aktivkonto. Resultatet bliver
forkert (udgifter 481,16 i stedet for 4.594,20). Et dashboard kan ikke vise de
rigtige tal før ledgeren er korrekt — derfor fixes importen først.

- [x] Opret feature-gren `feat/cockpit-redesign`
- [x] Træk Helheims faktiske tal — bekræftet gap mod ground truth
- [x] Fix `reconcileChartOfAccounts`: kildens kontoplan er nu autoritativ —
      kolliderende konti uden posteringer reklassificeres til kildens værdier.
      #193-tests opdateret.
- [x] Geninporteret Helheim i frisk virksomhed; ledger verificeret:
      Omsætning 17.829,02 · Udgifter 4.594,20 · Resultat 13.234,82 ✓
- [x] Tilføjet Chart.js + react-chartjs-2 i `app/`
- [x] Etableret designsystem-tokens i `app/src/styles.css`
- [x] Backend: `/api/companies/:slug/fiscal-years`
- [x] App kører via preview (backend hoster `app/dist` på :4319)
- [x] Baseline screenshot taget — nuværende dashboard er en flad felt-liste:
      mangler resultat/P&L helt, moms viser 0 (forkert), ingen grafer/årsvalg
- [x] **Visuel inspektion** — baseline dokumenteret, ledger verificeret korrekt

### Iteration 1 — Overblik (P0)
- [x] Backend: `/api/companies/:slug/overview?year=` — P&L (med måneds-
      opdeling), bank, moms, undtagelser, seneste posteringer; årsbevidst
- [x] Frontend: global regnskabsårs-vælger (dropdown, genindlæser ved skift)
- [x] Frontend: Overblik-view — KPI-kort (Omsætning / Udgifter / Resultat)
- [x] Frontend: P&L-graf måned for måned (Chart.js)
- [x] Frontend: statuskort — Bank, Moms, Undtagelser/Opgaver, Seneste posteringer
- [x] Responsivt layout (desktop + mobil)
- [x] **Visuel inspektion** — tal matcher ground truth (Resultat 13.234,82);
      graf + KPI-kort + statuskort verificeret på desktop og mobil

### Iteration 2 — Regnskabsopgørelser (P1)
- [x] Backend: income-statement, balance, trial-balance endpoints (årsbevidste)
- [x] Frontend: Resultatopgørelse-view (med foregående år til sammenligning)
- [x] Frontend: Balance-view
- [x] Frontend: Saldobalance-view
- [x] Per-virksomhed sub-navigation (Overblik · Resultatopgørelse · Balance ·
      Saldobalance); valgt regnskabsår bæres i URL'en (`?year=`) på tværs af views
- [x] **Visuel inspektion** — Resultatopgørelse (resultat 13.234,82), Balance
      (aktiver 42.290,03, balancerer), Saldobalance verificeret desktop + mobil

### Iteration 3 — Ledger-detaljer (P1–P2)
- [x] Backend: journal, bank, vat, documents endpoints (årsbevidste)
- [x] Frontend: Posteringer-view + drill-down til entry-linjer
- [x] Frontend: Bank-view — transaktioner + afstemningsstatus
- [x] Frontend: Moms-view — momsangivelse for perioden
- [x] Frontend: Bilag-view — dokumenter + link til posteringer
- [x] Sub-navigation udvidet til 8 punkter; `?year=` bæres på tværs
- [x] **Visuel inspektion** — Posteringer (10 entries, drill-down), Bank
      (saldo 41.388,03, 19 txn i 2026), Moms (3.371,20 at betale), Bilag
      (5 stk., linket til posteringer); desktop + mobil. NB: Moms-viewet
      lægger 64040 omvendt-betalingspligt-moms ind i salgsmoms — polish-punkt.

### Iteration 4 — Multi-år (P2–P3)
- [x] Backend: archive endpoints (#197-data 2023–25) + multi-year-endpoint —
      `GET .../archive/:year` (saldobalance + posteringssammendrag) og
      `GET .../multi-year` (omsætning/udgifter/resultat pr. år, ældste→nyeste;
      arkiv-år klassificeret via `accounts.type`)
- [x] Frontend: Arkiv-view — arkiveret års saldobalance, read-only, tydeligt
      mærket "Arkiveret regnskabsår — skrivebeskyttet"
- [x] Frontend: Flerårsoversigt — nøgletals-tabel + Chart.js-trendgraf (2023→26)
- [x] Regnskabsårs-vælger spænder over arkiv + live; CompanyNav udvidet til 10
      punkter; arkiverede år i live-views linker nu til Arkiv-viewet
- [ ] **Visuel inspektion**

### Iteration 5 — Kontakter, fakturaer & finish (P3)
- [ ] Backend: invoices, contacts endpoints
- [ ] Frontend: Fakturaer-view
- [ ] Frontend: Kontakter-view
- [ ] Sidste responsiv- og designpolering på tværs af alle views
- [ ] **Visuel inspektion** — hele cockpittet; informationsparitet med Dinero bekræftet
