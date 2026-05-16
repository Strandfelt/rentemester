![Rentemester banner](assets/rentemester-banner.png)

# Rentemester

**Bogholderen i maskinen — bygget til små danske virksomheder.**

Rentemester er et kommende bogholderisystem for danske mikrovirksomheder, freelancere, konsulenter og små ApS’er, hvor en AI-agent kan hjælpe med det daglige bogholderarbejde — mens selve regnskabet styres af faste regler, bilag, momslogik og en kontrollerbar historik.

Målet er enkelt:

> Du skal ikke bruge aftenen på at klikke rundt i et regnskabsprogram.  
> Systemet skal finde bilag, matche betalinger, bogføre det sikre og spørge dig om resten.

Rentemester er stadig under udvikling, men retningen er klar: **agent-first bogholderi med danske regler som fundament.**

---

## Hvem er Rentemester til?

Rentemester er tænkt til dig, der driver en mindre dansk virksomhed med relativt simple forhold:

- freelance- eller konsulentvirksomhed
- enkeltmandsvirksomhed
- lille ApS
- få ansatte eller ingen ansatte
- almindelige udgifter, bilag og fakturaer
- dansk moms
- behov for revisor- eller bogholder-eksport

Det er **ikke** tænkt som første version til store virksomheder, lager, løn, kasseapparat, avanceret projektregnskab eller komplekse internationale forhold.

---

## Hvad skal Rentemester kunne?

På sigt skal Rentemester kunne hjælpe med det praktiske bogholderi fra ende til ende:

- hente bilag fra en bilagsmail
- gemme bilag sikkert med dokumentation
- importere banktransaktioner
- matche banklinjer med bilag
- foreslå eller vælge korrekt konto og moms
- bogføre tydelige og sikre posteringer
- stoppe usikre posteringer og lave en opgaveliste
- oprette og sende fakturaer
- holde styr på åbne og betalte fakturaer
- lave momsrapport
- lave eksportpakke til revisor
- dokumentere hvad der er sket, hvornår og hvorfor

Den vigtige pointe er, at AI’en **ikke bare får lov til at gætte**.

AI-agenten kan gøre arbejdet, men Rentemesters kerne skal kontrollere, at bogføringen overholder reglerne.

---

## Grundideen

Traditionelle regnskabssystemer er ofte bygget sådan her:

```text
Du logger ind
→ finder bilag
→ vælger konti
→ afstemmer bank
→ laver moms
→ eksporterer til revisor
```

Rentemester vender modellen om:

```text
Systemet indsamler data
→ agenten udfører rutinearbejdet
→ reglerne kontrollerer alt
→ du håndterer kun undtagelserne
```

Med andre ord:

> **Agenten handler. Reglerne afgør. Ledgeren håndhæver.**

---

## Hvorfor ikke bare “AI i et regnskabsprogram”?

Fordi bogføring kræver tillid.

En chatbot må gerne være kreativ. Et bogholdersystem må ikke være kreativt med dit regnskab.

Rentemester bygges derfor med en hård kerne:

- dobbelt bogholderi
- debet skal være lig kredit
- bilag skal gemmes og kunne spores
- bogførte posteringer må ikke bare ændres
- fejl skal rettes med nye posteringer
- moms skal beregnes efter tydelige regler
- fakturaer skal valideres før de udstedes
- alle handlinger skal kunne revideres

AI’en må hjælpe. Systemet skal sige nej, når noget ikke er sikkert nok.

---

## Eksempel på en hverdag med Rentemester

Forestil dig en typisk måned:

1. Du sender eller videresender bilag til en bilagsmail.
2. Rentemester importerer bankbevægelser.
3. Systemet matcher f.eks. Stripe, Google, OpenAI, DSB og kontorudgifter med bilag.
4. Klare posteringer bogføres automatisk.
5. Usikre ting kommer i en kort opgaveliste:
   - “Restaurantbilag mangler formål og deltagere”
   - “Bilag mangler for kortbetaling på 1.250 kr.”
   - “Leverandør fra EU kræver reverse charge-vurdering”
6. Du svarer kun på det, der kræver menneskelig viden.
7. Ved momsperiodens slutning får du en rapport og eksport til revisor.

Målet er ikke at fjerne ansvar. Målet er at fjerne gentagelser, rod og unødige klik.

---

## Hvad er bygget nu?

Rentemester er i en tidlig teknisk prototype. Den nuværende version har allerede en fungerende kerne for:

- virksomhedsmappe med lokale data
- SQLite-ledger
- append-only bogføringshistorik
- audit/hash-kæde til integritetskontrol
- dansk kontoplan-lite
- import af bank-CSV
- simpel bankafstemning
- indlæsning og hashing af bilag
- validering af danske fakturaoplysninger
- bogføring af journalposter med krav om balance
- tilbageførsel af posteringer via reversal — ikke sletning
- momsrapport for periode
- EU-køb af ydelser med reverse charge
- downloadede og hash-verificerede danske retskilder
- automatiske tests
- container-runtime til drift med monterede virksomhedsmappen

Det er ikke færdigt, men fundamentet er lagt rigtigt: regler først, dokumentation først, audit først.

---

## Hvad mangler stadig?

Før Rentemester kan bruges som rigtigt bogholderisystem, mangler bl.a.:

- bedre automatisk match mellem bank og bilag
- egentlig opgaveliste for undtagelser
- fakturaoprettelse og PDF-faktura
- udsendelse af fakturaer via mail
- indbetalinger matchet mod fakturaer
- fuld bilagsmail-import
- backup- og restore-test
- eksportpakke til revisor
- brugerflade eller enkel kontrolside
- mere komplet dansk regelbibliotek
- grundig review med bogholder/revisor

Rentemester skal ikke kaldes færdigt, før det kan tåle at være source of truth.

---

## Danske regler og kilder

Rentemester bygges med danske regler som udgangspunkt.

Projektet samler og versionsstyrer relevante kilder som bl.a.:

- Bogføringsloven
- krav til digitale bogføringssystemer
- Momsloven
- Momsbekendtgørelsen
- regler om bilag, opbevaring og fakturaer

Regler skal ikke bare beskrives i tekst. De skal gøres testbare:

- Hvad kræver reglen?
- Hvornår gælder den?
- Hvad skal systemet afvise?
- Hvilken kilde bygger det på?
- Findes der en test, der beviser det?

Det er den langsomme vej. Men det er den rigtige vej.

---

## Open source og ingen lock-in

Rentemester bygges som open source.

Principperne er:

- dine regnskabsdata skal være dine
- systemet skal kunne køre lokalt eller på egen server
- data skal kunne eksporteres
- bilag skal gemmes i almindelige mapper
- der skal være audit trail
- systemet må ikke låse dig inde

En lille virksomhed skal ikke miste adgang til sit regnskab, fordi et abonnement, API eller eksternt system ændrer sig.

---

## Vigtigt forbehold

Rentemester er **ikke** en revisor, bogholder eller juridisk rådgiver.

Projektet er under udvikling og må ikke bruges ukritisk til rigtig bogføring endnu. Brug altid sund fornuft, og få hjælp fra en bogholder eller revisor, når det gælder moms, skat, årsregnskab og tvivlsspørgsmål.

Ambitionen er, at Rentemester på sigt kan blive et pålideligt værktøj — men tillid skal fortjenes med regler, tests, dokumentation og praktisk brug.

---

## Kort sagt

Rentemester er et forsøg på at bygge bogholderi til en ny virkelighed:

```text
Agenten er bogholderen.
Ledgeren er loven.
Reglerne er kontrakten.
Bilagene er beviserne.
Dashboardet er kontrolrummet.
```

Et regnskabssystem bygget til AI-agenter — men med danske regler, bilag og revision i centrum.
