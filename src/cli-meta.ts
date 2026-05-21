type CommandSpec = {
  key: string;
  usage: string;
  description: string;
  allowedFlags: string[];
  examplePath?: string;
  exampleHint?: string;
  inputNotes?: string[];
};

const GLOBAL_FLAGS = ["--help", "--example", "--format", "--json", "--actor", "--actor-via"];

export const COMMAND_SPECS: CommandSpec[] = [
  {
    key: "init",
    usage: "init --company <path> [--workspace <dir>] [--cvr <DK12345678>] [--fiscal-year-start-month <1-12>] [--fiscal-year-label-strategy end-year|start-year|span]",
    description: "Initialiserer en virksomhed og opretter standardkontoplan.",
    allowedFlags: ["--company", "--workspace", "--cvr", "--fiscal-year-start-month", "--fiscal-year-label-strategy"],
    inputNotes: [
      "Ligger virksomhedsmappen i et workspace (via --workspace eller RENTEMESTER_WORKSPACE), registreres virksomheden også i workspacet, så Cockpittet kan se den.",
      "Momsperioden antages at være kvartal — afstem dine momsperioder hvis du afregner måneds- eller halvårsmoms.",
    ],
  },
  {
    key: "company add",
    usage: "company add [--workspace <dir>] --name <text> [--slug <slug>] [--cvr <DK12345678>] [--fiscal-year-start-month <1-12>] [--fiscal-year-label-strategy end-year|start-year|span]",
    description: "Opretter en ny virksomhed i workspacet (opretter workspacet ved første kørsel).",
    allowedFlags: ["--workspace", "--name", "--slug", "--cvr", "--fiscal-year-start-month", "--fiscal-year-label-strategy"],
  },
  {
    key: "company list",
    usage: "company list [--workspace <dir>]",
    description: "Lister virksomheder i workspacet.",
    allowedFlags: ["--workspace"],
  },
  {
    key: "company sync-cvr",
    usage: "company sync-cvr --company <slug|path>",
    description: "Henter virksomhedens stamdata fra CVR-registret og opdaterer navn, adresse, branche, virksomhedsform og status. Regnskabsåret røres aldrig — et afvigende regnskabsår rapporteres kun.",
    allowedFlags: ["--company"],
    inputNotes: [
      "Kræver miljøvariablerne CVR_USERNAME og CVR_PASSWORD (opret adgang på virk.dk)",
      "Virksomheden skal have et CVR-nummer registreret",
      "CVR-data er et snapshot — det caches lokalt og læses aldrig live under bogføring",
    ],
  },
  {
    key: "serve",
    usage: "serve [--workspace <dir>] [--host <addr>] [--port <n>]",
    description: "Starter cockpit-backenden: en lokal JSON-API over workspacet (kun læsning + workspace-styring).",
    allowedFlags: ["--workspace", "--host", "--port"],
    inputNotes: [
      "Bind-adressen er konfigurations-styret: standard 127.0.0.1 (kun localhost)",
      "Miljøvariabler: RENTEMESTER_APP_HOST, RENTEMESTER_APP_PORT, RENTEMESTER_WORKSPACE",
      "Ingen bogføringsmutationer — dem ejer agent/CLI-stien",
    ],
  },
  { key: "system healthcheck", usage: "system healthcheck --company <slug|path>", description: "Tjekker at virksomhedsmappen og kernefiler findes.", allowedFlags: ["--company"] },
  { key: "system backup", usage: "system backup --company <path> [--at <ISO-8601>] [--sign-with-ed25519] [--archive]", description: "Opretter en revisionsklar backup. Med --sign-with-ed25519 tilføjes en asymmetrisk signatur som 3.-part kan verificere uafhængigt. Med --archive pakkes backuppen straks til én .tar-fil klar til off-site placering.", allowedFlags: ["--company", "--at", "--sign-with-ed25519", "--archive"] },
  { key: "system backup-status", usage: "system backup-status --company <path> [--as-of <ISO-8601>]", description: "Viser om backup-pligten er opfyldt.", allowedFlags: ["--company", "--as-of"] },
  {
    key: "system restore-backup",
    usage: "system restore-backup --backup-dir <dir-eller-.tar> --target-company <path> --confirm yes [--verify-key <path>] [--public-key <path>]",
    description:
      "DESTRUKTIV: gendanner en backup til --target-company. Sletter ingen filer på source, men OVERSKRIVER eksisterende filer i --target-company. Kræver --confirm yes — uden den afvises kommandoen uden at røre filsystemet. --backup-dir kan pege på enten en backup-mappe eller et .tar-arkiv (kræver typisk --verify-key for et arkiv).",
    allowedFlags: ["--backup-dir", "--target-company", "--confirm", "--verify-key", "--public-key"],
    inputNotes: [
      "--confirm yes er påkrævet: restore kan overskrive filer i --target-company",
      "Restore rører aldrig backup-kilden — kun --target-company skrives",
      "MCP-ækvivalenten system_restore_backup kræver confirm:true + confirmText='RESTORE <targetCompany>'",
    ],
  },
  { key: "system backup-archive", usage: "system backup-archive --company <path> [--backup-id <id>] [--out <file.tar>]", description: "Pakker en eksisterende backup til én deterministisk .tar-fil (+ .sha256-sidecar) klar til at flytte off-site. Uden --backup-id pakkes den nyeste backup.", allowedFlags: ["--company", "--backup-id", "--out"] },
  { key: "system backup-governance", usage: "system backup-governance --company <path> [--as-of <ISO-8601>]", description: "Viser den samlede backup-status: forfald, bogførings-lås, destinationer og om seneste backup er placeret sikkert i EU/EØS.", allowedFlags: ["--company", "--as-of"] },
  { key: "system backup-destinations", usage: "system backup-destinations --company <path>", description: "Lister konfigurerede backup-destinationer med deres EU/EØS- og it-sikkerheds-attestering.", allowedFlags: ["--company"] },
  {
    key: "system backup-add-destination",
    usage: "system backup-add-destination --company <path> --label <text> --kind local-folder|dropbox|google-drive|ssh|other --location <path|uri> --region-eu true|false --attested-by <actor> [--region-country <kode>] [--region-note <text>] [--non-related true|false] [--it-security true|false] [--it-security-note <text>] [--at <ISO-8601>]",
    description: "Tilføjer en backup-destination. Du attesterer som menneske om destinationen ligger på en server i EU/EØS, jf. BEK 205/2024 § 4, stk. 2 — Rentemester kan ikke selv vide det.",
    allowedFlags: ["--company", "--label", "--kind", "--location", "--region-eu", "--attested-by", "--region-country", "--region-note", "--non-related", "--it-security", "--it-security-note", "--at"],
  },
  { key: "system backup-remove-destination", usage: "system backup-remove-destination --company <path> --id <dest-id>", description: "Fjerner en konfigureret backup-destination.", allowedFlags: ["--company", "--id"] },
  {
    key: "system backup-place",
    usage: "system backup-place --company <path> --archive-file <file.tar> --destination <dest-id> [--actor-kind human|agent] [--at <ISO-8601>] [--note <text>]",
    description: "Kopierer et backup-arkiv til en destination med en lokal/synkroniseret mappe (fx en Dropbox- eller Google Drive-desktopmappe) og verificerer kopien med sha256.",
    allowedFlags: ["--company", "--archive-file", "--destination", "--actor-kind", "--at", "--note"],
  },
  {
    key: "system backup-confirm-placement",
    usage: "system backup-confirm-placement --company <path> --destination <dest-id> --backup-id <id> --archive-sha256 <hex> [--archive-size <bytes>] [--actor-kind human|agent] [--at <ISO-8601>] [--note <text>]",
    description: "Registrerer en backup-placering foretaget uden for Rentemester — fx en agent der har pushet arkivet til Dropbox/Drive/SSH med egne værktøjer. Verificeres med sha256 hvis destinationen er læsbar.",
    allowedFlags: ["--company", "--destination", "--backup-id", "--archive-sha256", "--archive-size", "--actor-kind", "--at", "--note"],
  },
  {
    key: "system backup-lock",
    usage: "system backup-lock --company <path> [--enforce true|false] [--grace-days <n>] [--at <ISO-8601>]",
    description: "Konfigurerer den frivillige bogførings-lås. Når den er slået til, blokeres ny bogføring hvis den ugentlige backup (BEK 205/2024 § 4) er forsømt ud over en eventuel grace-periode. system-, backup- og restore-kommandoer blokeres aldrig.",
    allowedFlags: ["--company", "--enforce", "--grace-days", "--at"],
  },
  { key: "system backup-guide", usage: "system backup-guide --company <path> --out <file.html> [--as-of <ISO-8601>]", description: "Genererer en HTML-side der forklarer backup-reglerne (bogføringsloven § 12/§ 15, BEK 205/2024 § 4) og viser virksomhedens aktuelle backup-status.", allowedFlags: ["--company", "--out", "--as-of"] },
  { key: "system export-public-key", usage: "system export-public-key --company <path> --out <file>", description: "Eksporterer virksomhedens ed25519 backup-public-key til en fil (deles med revisor/myndighed).", allowedFlags: ["--company", "--out"] },
  { key: "system verify-backup-signature", usage: "system verify-backup-signature --backup-dir <dir> [--public-key <path>] [--verify-key <path>]", description: "Verificerer signaturen på en backup uden at restore. Med --public-key kan en 3.-part verificere uden source-adgang.", allowedFlags: ["--backup-dir", "--public-key", "--verify-key"] },
  { key: "system export-authority", usage: "system export-authority --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD> --out <dir> [--requested-at <ISO-8601>] [--requester <name>]", description: "Eksporterer materiale til myndighedsudlevering.", allowedFlags: ["--company", "--from", "--to", "--out", "--requested-at", "--requester"] },
  { key: "system export-accountant", usage: "system export-accountant --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD> --out <dir> [--requested-at <ISO-8601>] [--requester <name>]", description: "Eksporterer en deterministisk lokal håndoff-pakke til bogholder eller revisor.", allowedFlags: ["--company", "--from", "--to", "--out", "--requested-at", "--requester"] },
  { key: "system export-saft", usage: "system export-saft --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD> --out <dir> [--generated-at <ISO-8601>]", description: "Eksporterer første deterministiske SAF-T-slice (kontoplan, journal og salgsfakturaer).", allowedFlags: ["--company", "--from", "--to", "--out", "--generated-at"] },
  { key: "audit verify", usage: "audit verify --company <path>", description: "Verificerer audit-kæde og bogføringsintegritet.", allowedFlags: ["--company"] },
  { key: "accounts list", usage: "accounts list --company <path>", description: "Lister kontoplanen.", allowedFlags: ["--company"] },
  {
    key: "customer create",
    usage:
      "customer create --company <path> --name <text> [--address <text>] [--cvr <DK...>] [--email <text>] [--ean <text>] [--payment-terms <days>] [--currency <ISO>] [--notes <text>] [--from-cvr <DK...>]",
    description: "Opretter en append-only kundepost til genbrug på fakturaer. Med --from-cvr udfyldes navn/adresse/CVR/email automatisk fra CVR-registret.",
    allowedFlags: ["--company", "--name", "--address", "--cvr", "--email", "--ean", "--payment-terms", "--currency", "--notes", "--from-cvr"],
    inputNotes: [
      "--from-cvr slår CVR-nummeret op i CVR-registret og udfylder felter brugeren ikke selv har sat",
      "Eksplicitte flag (--name, --address, ...) vinder altid over CVR-data",
      "--from-cvr kræver CVR_USERNAME/CVR_PASSWORD som miljøvariabler",
    ],
  },
  { key: "customer list", usage: "customer list --company <path> [--archived]", description: "Lister kendte kunder.", allowedFlags: ["--company", "--archived"] },
  { key: "customer validate-vat", usage: "customer validate-vat --company <path> --cvr <EU-VAT>", description: "Validerer et EU-VAT-nummer via VIES og cacher resultatet.", allowedFlags: ["--company", "--cvr"] },
  {
    key: "customer cvr-lookup",
    usage: "customer cvr-lookup --company <path> --cvr <DK12345678>",
    description: "Slår en virksomhed op i CVR-registret og viser stamdata (navn, adresse, branche, form, status, ledelse). Read-only; cacher snapshottet. Kræver CVR_USERNAME/CVR_PASSWORD.",
    allowedFlags: ["--company", "--cvr"],
  },
  { key: "vendor create", usage: "vendor create --company <path> --name <text> [--address <text>] [--cvr <DK...>] [--expense-account <konto>] [--default-vat <text>] [--notes <text>] [--from-cvr <DK...>]", description: "Opretter en append-only leverandørpost til bilagsindlæsning. Med --from-cvr udfyldes navn/adresse/CVR automatisk fra CVR-registret.", allowedFlags: ["--company", "--name", "--address", "--cvr", "--expense-account", "--default-vat", "--notes", "--from-cvr"] },
  { key: "vendor list", usage: "vendor list --company <path> [--archived]", description: "Lister kendte leverandører.", allowedFlags: ["--company", "--archived"] },
  { key: "exceptions list", usage: "exceptions list --company <path> [--status open|resolved|all] [--include-archived]", description: "Lister exceptions-køen. Exceptions i arkiverede/lukkede perioder udelades som standard — vis dem med --include-archived.", allowedFlags: ["--company", "--status", "--include-archived"] },
  { key: "exceptions resolve", usage: "exceptions resolve --company <path> --id <n> [--note <text>]", description: "Markerer en exception som løst.", allowedFlags: ["--company", "--id", "--note"] },
  {
    key: "invoice validate",
    usage: "invoice validate --input <file.json>",
    description: "Validerer en faktura-payload uden at gemme den.",
    allowedFlags: ["--input"],
    examplePath: "examples/full-invoice.dk.json",
    exampleHint: "rentemester invoice validate --example > faktura.json",
    inputNotes: [
      'invoiceType: "full" | "simplified"',
      'vatTreatment: "standard" | "domestic_reverse_charge" | "foreign_reverse_charge"',
      "issueDate: YYYY-MM-DD",
      "seller, buyer, lines, totals, currency",
      "Alle beløbsfelter er i KRONER (decimal, fx 1000.00) — ikke øre",
    ],
  },
  {
    key: "invoice issue",
    usage: "invoice issue --company <path> --input <file.json> [--customer-id <n>]",
    description: "Udsteder en kundefaktura og gemmer et immutabelt snapshot.",
    allowedFlags: ["--company", "--input", "--customer-id"],
    examplePath: "examples/full-invoice.dk.json",
    exampleHint: "rentemester invoice issue --example > faktura.json",
    inputNotes: [
      'invoiceType: "full" | "simplified"',
      'vatTreatment: "standard" | "domestic_reverse_charge" | "foreign_reverse_charge"',
      "issueDate: YYYY-MM-DD",
      "invoiceNumber: valgfri; udelad for automatisk nummerering",
      "seller: { name, address, vatOrCvr }",
      "buyer: { name, address, ... }",
      "lines: [{ description, quantity, unitPriceExVat, lineTotalExVat }]",
      "totals: { netAmount, vatRate, vatAmount, grossAmount }",
      "Beløbsfelter (unitPriceExVat, lineTotalExVat, netAmount, vatAmount, grossAmount) er i KRONER (decimal) — ikke øre. vatRate er en procent (fx 25)",
      'currency: "DKK"',
      "dueDate: YYYY-MM-DD",
    ],
  },
  { key: "invoice render", usage: "invoice render --company <path> (--document-id <n> | --invoice-number <no>)", description: "Renderer eller genskaber en deterministisk PDF for en udstedt faktura.", allowedFlags: ["--company", "--document-id", "--invoice-number"] },
  { key: "invoice export-public", usage: "invoice export-public --company <path> (--document-id <n> | --invoice-number <no>) --out <file.xml>", description: "Eksporterer en deterministisk preview-artifact til offentlig EAN/GLN e-faktura uden PEPPOL-transport.", allowedFlags: ["--company", "--document-id", "--invoice-number", "--out"] },
  { key: "invoice export-public-oioubl", usage: "invoice export-public-oioubl --company <path> (--document-id <n> | --invoice-number <no>) --out <file.xml>", description: "Eksporterer et deterministisk OIOUBL-handoff-artifact til offentlig e-faktura uden direkte PEPPOL-submission.", allowedFlags: ["--company", "--document-id", "--invoice-number", "--out"] },
  // PEPPOL submission (#128)
  { key: "invoice submit-public-peppol", usage: "invoice submit-public-peppol --company <path> (--document-id <n> | --invoice-number <no>) --access-point <file.json> [--out <file.xml>]", description: "Bygger en deterministisk, idempotent PEPPOL-submission-envelope oven på OIOUBL-handoff-artifaktet. Access-point-config læses fra fil; credentials gemmes aldrig i bogføringstilstanden.", allowedFlags: ["--company", "--document-id", "--invoice-number", "--access-point", "--out"] },
  {
    key: "invoice credit-note",
    usage: "invoice credit-note --company <path> --input <file.json>",
    description: "Udsteder en kreditnota mod en eksisterende faktura.",
    allowedFlags: ["--company", "--input"],
    examplePath: "examples/credit-note.json",
    inputNotes: [
      "originalInvoiceNumber: fakturanummer (fx \"2026-0001\") ELLER originalInvoiceDocumentId: heltal — én af dem påkrævet",
      "issueDate: YYYY-MM-DD (påkrævet)",
      "reason: tekst (påkrævet)",
      "grossAmount: valgfrit beløb i KRONER (decimal) — udelad for fuld kreditering af fakturaen",
      "creditNoteNumber: valgfri; udelad for automatisk nummerering",
    ],
  },
  { key: "invoice post", usage: "invoice post --company <path> (--document-id <n> | --invoice-number <no>)", description: "Bogfører en udstedt faktura i finansen.", allowedFlags: ["--company", "--document-id", "--invoice-number"] },
  {
    key: "invoice settle-bank",
    usage: "invoice settle-bank --company <path> --input <file.json>",
    description: "Matcher en bankbetaling mod en faktura.",
    allowedFlags: ["--company", "--input"],
    examplePath: "examples/invoice-settlement.json",
    inputNotes: [
      "invoiceNumber: fakturanummer (fx \"2026-0001\") ELLER invoiceDocumentId: heltal — én af dem påkrævet",
      "bankTransactionReference: bankpostens reference ELLER bankTransactionId: heltal — én af dem påkrævet",
      "paymentDate: valgfri YYYY-MM-DD — udelad for at bruge bankpostens dato",
      "amount: valgfrit beløb i KRONER (decimal) — udelad for at bruge bankpostens beløb",
      "bankAccountNo / receivableAccountNo: valgfri kontonumre (standard 2000 / 1100)",
    ],
  },
  {
    key: "invoice settle-claim-bank",
    usage: "invoice settle-claim-bank --company <path> --input <file.json>",
    description: "Matcher en bankbetaling mod fakturakrav.",
    allowedFlags: ["--company", "--input"],
    examplePath: "examples/invoice-claim-settlement.json",
    inputNotes: [
      "invoiceNumber: fakturanummer (fx \"2026-0001\") ELLER invoiceDocumentId: heltal — én af dem påkrævet",
      "bankTransactionReference: bankpostens reference ELLER bankTransactionId: heltal — én af dem påkrævet",
      "paymentDate: valgfri YYYY-MM-DD — udelad for at bruge bankpostens dato",
      "amount: valgfrit beløb i KRONER (decimal) — udelad for at bruge bankpostens beløb",
      "bankAccountNo / receivableAccountNo: valgfri kontonumre (standard 2000 / 1100)",
    ],
  },
  {
    key: "invoice write-off-bad-debt",
    usage: "invoice write-off-bad-debt --company <path> --input <file.json>",
    description: "Bogfører tab på debitor.",
    allowedFlags: ["--company", "--input"],
    examplePath: "examples/invoice-bad-debt-writeoff.json",
    inputNotes: [
      "invoiceNumber: fakturanummer (fx \"2026-0001\") ELLER invoiceDocumentId: heltal — én af dem påkrævet",
      "writeOffDate: YYYY-MM-DD (påkrævet)",
      "grossAmount: valgfrit positivt beløb i KRONER (decimal) — udelad for at afskrive hele den åbne saldo",
      "expenseAccountNo / receivableAccountNo / vatAccountNo: valgfri kontonumre",
      "note: valgfri tekst",
    ],
  },
  {
    key: "invoice refund-bank",
    usage: "invoice refund-bank --company <path> --input <file.json>",
    description: "Bogfører refundering til kunden fra banken.",
    allowedFlags: ["--company", "--input"],
    examplePath: "examples/invoice-refund.json",
    inputNotes: [
      "invoiceNumber: fakturanummer (fx \"2026-0001\") ELLER invoiceDocumentId: heltal — én af dem påkrævet",
      "bankTransactionReference: bankpostens reference ELLER bankTransactionId: heltal — én af dem påkrævet (skal være en udgående postering)",
      "refundDate: valgfri YYYY-MM-DD — udelad for at bruge bankpostens dato",
      "amount: valgfrit beløb i KRONER (decimal) — udelad for at bruge bankpostens beløb (numerisk værdi)",
      "bankAccountNo / receivableAccountNo: valgfri kontonumre (standard 2000 / 1100)",
    ],
  },
  {
    key: "invoice apply-payment",
    usage: "invoice apply-payment --company <path> --input <file.json>",
    description: "Registrerer en fakturabetaling direkte fra payload.",
    allowedFlags: ["--company", "--input"],
    examplePath: "examples/invoice-payment.json",
    inputNotes: [
      "invoiceNumber: fakturanummer (fx \"2026-0001\") ELLER invoiceDocumentId: heltal — én af dem påkrævet",
      "paymentDate: YYYY-MM-DD (påkrævet)",
      "amount: positivt beløb i KRONER (decimal, fx 1250.00) — påkrævet",
      "bankTransactionId / journalEntryId: valgfri heltal — knytter betalingen til en bankpost/finanspostering",
      "bankAccountNo / receivableAccountNo: valgfri kontonumre",
      "note: valgfri tekst",
    ],
  },
  { key: "invoice remind", usage: "invoice remind --company <path> (--document-id <n> | --invoice-number <no>) --date <YYYY-MM-DD> [--fee <n>] [--note <text>]", description: "Registrerer en rykker på en forfalden faktura.", allowedFlags: ["--company", "--document-id", "--invoice-number", "--date", "--fee", "--note"] },
  { key: "invoice post-reminder", usage: "invoice post-reminder --company <path> (--document-id <n> | --invoice-number <no>) [--reminder-id <n>] [--date <YYYY-MM-DD>]", description: "Bogfører en registreret rykker.", allowedFlags: ["--company", "--document-id", "--invoice-number", "--reminder-id", "--date"] },
  { key: "invoice status", usage: "invoice status --company <path> (--document-id <n> | --invoice-number <no>) [--as-of <YYYY-MM-DD>]", description: "Viser åben saldo og status på en faktura.", allowedFlags: ["--company", "--document-id", "--invoice-number", "--as-of"] },
  {
    key: "invoice list",
    usage:
      "invoice list --company <path> [--status open|paid|credited|refunded|overpaid|written_off|overdue|all] [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--customer-cvr <DK...>] [--customer <text>] [--invoice-number <no>] [--min-amount <n>] [--max-amount <n>] [--as-of <YYYY-MM-DD>]",
    description: "Lister udstedte fakturaer med filtre for status, kunde og dato.",
    allowedFlags: ["--company", "--status", "--from", "--to", "--customer-cvr", "--customer", "--invoice-number", "--min-amount", "--max-amount", "--as-of"],
  },
  { key: "invoice find", usage: "invoice find --company <path> [<query>] [--customer <text>] [--amount <n>] [--invoice-number <no>] [--as-of <YYYY-MM-DD>]", description: "Finder udstedte fakturaer via nummer, kunde eller beløb.", allowedFlags: ["--company", "--customer", "--amount", "--invoice-number", "--as-of"] },
  { key: "invoice overdue", usage: "invoice overdue --company <path> [--as-of <YYYY-MM-DD>] [--min-days <n>]", description: "Lister forfaldne udstedte fakturaer som ikke er fuldt afregnet.", allowedFlags: ["--company", "--as-of", "--min-days"] },
  { key: "invoice interest", usage: "invoice interest --company <path> (--document-id <n> | --invoice-number <no>) --as-of <YYYY-MM-DD> --reference-rate <pct>", description: "Beregner morarente på en faktura.", allowedFlags: ["--company", "--document-id", "--invoice-number", "--as-of", "--reference-rate"] },
  { key: "invoice claim-interest", usage: "invoice claim-interest --company <path> (--document-id <n> | --invoice-number <no>) --as-of <YYYY-MM-DD> --reference-rate <pct> [--note <text>]", description: "Registrerer et morarentekrav.", allowedFlags: ["--company", "--document-id", "--invoice-number", "--as-of", "--reference-rate", "--note"] },
  { key: "invoice post-interest", usage: "invoice post-interest --company <path> (--document-id <n> | --invoice-number <no>) [--claim-id <n>] [--date <YYYY-MM-DD>]", description: "Bogfører et registreret morarentekrav.", allowedFlags: ["--company", "--document-id", "--invoice-number", "--claim-id", "--date"] },
  { key: "invoice compensation", usage: "invoice compensation --company <path> (--document-id <n> | --invoice-number <no>) --as-of <YYYY-MM-DD> [--amount-dkk <n>]", description: "Beregner kompensationskrav for sen betaling.", allowedFlags: ["--company", "--document-id", "--invoice-number", "--as-of", "--amount-dkk"] },
  { key: "invoice claim-compensation", usage: "invoice claim-compensation --company <path> (--document-id <n> | --invoice-number <no>) --as-of <YYYY-MM-DD> [--amount-dkk <n>] [--note <text>]", description: "Registrerer kompensationskrav.", allowedFlags: ["--company", "--document-id", "--invoice-number", "--as-of", "--amount-dkk", "--note"] },
  { key: "invoice post-compensation", usage: "invoice post-compensation --company <path> (--document-id <n> | --invoice-number <no>) [--date <YYYY-MM-DD>]", description: "Bogfører registreret kompensation.", allowedFlags: ["--company", "--document-id", "--invoice-number", "--date"] },
  { key: "documents ingest", usage: "documents ingest --company <path> --file <path> --metadata <file.json> [--vendor-id <n>] [--force]", description: "Indlæser og validerer et bilag med metadata.", allowedFlags: ["--company", "--file", "--metadata", "--vendor-id", "--force"], examplePath: "examples/vendor-invoice.metadata.json" },
  { key: "documents list", usage: "documents list --company <path>", description: "Lister gemte bilag.", allowedFlags: ["--company"] },
  // ===== BANK CLUSTER (#186-189) =====
  { key: "bank-account add", usage: "bank-account add --company <path> --name <text> [--slug <slug>] [--bank-name <text>] [--registration-no <regnr>] [--account-no <kontonr>] [--iban <iban>] [--currency <ISO>] [--ledger-account <konto>]", description: "Opretter en bankkonto i virksomhedens ledger.", allowedFlags: ["--company", "--name", "--slug", "--bank-name", "--registration-no", "--account-no", "--iban", "--currency", "--ledger-account"] },
  { key: "bank-account list", usage: "bank-account list --company <path>", description: "Lister registrerede bankkonti.", allowedFlags: ["--company"] },
  { key: "bank import", usage: "bank import --company <path> --file <transactions.csv> [--account <id|slug>] [--profile danske-bank]", description: "Importerer banktransaktioner fra CSV.", allowedFlags: ["--company", "--file", "--account", "--profile"], examplePath: "examples/bank-transactions.csv" },
  { key: "bank list", usage: "bank list --company <path> [--status all|matched|unmatched] [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--text-match <text>] [--amount <n>] [--account <id|slug>]", description: "Lister importerede banktransaktioner med filtre for afstemningsstatus.", allowedFlags: ["--company", "--status", "--from", "--to", "--text-match", "--amount", "--account"] },
  { key: "bank suggest-matches", usage: "bank suggest-matches --company <path> [--bank-transaction-id <n>] [--max <n>]", description: "Foreslår deterministiske match mellem uafstemte banktransaktioner og fakturaer/bilag.", allowedFlags: ["--company", "--bank-transaction-id", "--max"] },
  { key: "reconcile bank", usage: "reconcile bank --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--status all|matched|unmatched] [--text-match <text>] [--amount <n>] [--account <id|slug>]", description: "Viser afstemte og uafstemte banktransaktioner med filtre.", allowedFlags: ["--company", "--from", "--to", "--status", "--text-match", "--amount", "--account"] },
  // ===== END BANK CLUSTER (#186-189) =====
  {
    key: "expense book",
    usage:
      "expense book --company <path> --document-id <n> --bank-transaction-id <n> --expense-account <konto> [--vat-treatment standard|reverse_charge|representation|exempt] [--payment-account <konto>] [--date <YYYY-MM-DD>] [--text <tekst>]",
    description: "Bogfører en leverandørudgift direkte fra bilag + bankpost.",
    allowedFlags: ["--company", "--document-id", "--bank-transaction-id", "--expense-account", "--vat-treatment", "--payment-account", "--date", "--text"],
  },
  { key: "vat report", usage: "vat report --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD>", description: "Bygger en momsrapport for perioden.", allowedFlags: ["--company", "--from", "--to"] },
  {
    key: "vat post-eu-service-purchase",
    usage: "vat post-eu-service-purchase --company <path> --input <file.json>",
    description: "Bogfører et EU-servicekøb med reverse charge.",
    allowedFlags: ["--company", "--input"],
    examplePath: "examples/eu-service-purchase.json",
    inputNotes: [
      "transactionDate: YYYY-MM-DD (påkrævet)",
      "text: tekst (påkrævet)",
      "invoiceNo: leverandørfakturaens nummer — slås op til documentId, ELLER angiv documentId: heltal direkte",
      "netAmount: positivt beløb i KRONER (decimal) — grundlaget eksklusive moms",
      "expenseAccountNo: udgiftskonto (påkrævet, fx \"3010\")",
      "paymentAccountNo: valgfri betalingskonto (standard 2000)",
      "Kun EU-leverandører uden for DK; bilagets sender_vat_cvr skal være VIES-valideret",
      "Ved currency != DKK kræves amountForeign, amountDkk og fxRateToDkk (beløb i KRONER)",
    ],
  },
  {
    key: "vat post-representation-purchase",
    usage: "vat post-representation-purchase --company <path> --input <file.json>",
    description: "Bogfører repræsentationsudgift med delvis momsfradrag.",
    allowedFlags: ["--company", "--input"],
    examplePath: "examples/representation-purchase.json",
    inputNotes: [
      "transactionDate: YYYY-MM-DD (påkrævet)",
      "text: tekst (påkrævet)",
      "documentId: heltal — bilags-id (påkrævet, positivt heltal)",
      "netAmount: positivt beløb i KRONER (decimal) — grundlaget eksklusive moms",
      "expenseAccountNo: valgfri udgiftskonto (standard 3070)",
      "paymentAccountNo: valgfri betalingskonto (standard 2000)",
      "Kun 25% af momsen fradrages; resten bogføres som ikke-fradragsberettiget",
      "Ved currency != DKK kræves amountForeign, amountDkk og fxRateToDkk (beløb i KRONER)",
    ],
  },
  { key: "period close", usage: "period close --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--kind vat_quarter|fiscal_year|custom] [--status closed|reported] [--reference <text>]", description: "Lukker eller markerer en regnskabsperiode.", allowedFlags: ["--company", "--from", "--to", "--kind", "--status", "--reference"] },
  { key: "retention status", usage: "retention status --company <path> [--as-of <YYYY-MM-DD>]", description: "Viser opbevaringsfrister og udløbet materiale.", allowedFlags: ["--company", "--as-of"] },
  {
    key: "journal post",
    usage: "journal post --company <path> --input <file.json>",
    description: "Bogfører en manuel finanspostering.",
    allowedFlags: ["--company", "--input"],
    examplePath: "examples/journal-entry.expense.json",
    inputNotes: [
      "transactionDate: YYYY-MM-DD (påkrævet)",
      "text: tekst (påkrævet)",
      "lines: mindst 2 linjer; hver linje { accountNo, debitAmount | creditAmount, vatCode?, text? }",
      "debitAmount/creditAmount: positivt beløb i KRONER (decimal, fx 1250.50) — ikke øre",
      "Hver linje har enten debitAmount eller creditAmount, aldrig begge; sum debet == sum kredit",
      "documentId: heltal — PÅKRÆVET når en linje rammer en udgifts- eller indtægtskonto (bilagsbevis)",
      'currency: valgfri 3-bogstavs ISO (standard "DKK")',
      "Ved currency != DKK kræves desuden amountForeign, amountDkk og fxRateToDkk (beløb i KRONER)",
    ],
  },
  {
    key: "journal reverse",
    usage:
      "journal reverse --company <path> (--entry-id <n> | --entry-no <no> | --match-text <text> [--match-date <YYYY-MM-DD>] [--match-document-id <n>]) --date <YYYY-MM-DD> --reason <text>",
    description: "Tilbagefører en bogført finanspostering.",
    allowedFlags: ["--company", "--entry-id", "--entry-no", "--match-text", "--match-date", "--match-document-id", "--date", "--reason"],
  },
  { key: "journal list", usage: "journal list --company <path>", description: "Lister finansposteringer.", allowedFlags: ["--company"] },
  {
    key: "dashboard",
    usage: "dashboard --company <path> --out <file.html> [--as-of <YYYY-MM-DD>] [--open]",
    description: "Genererer et statisk HTML-dashboard over virksomhedens nuværende bogføringsstatus.",
    allowedFlags: ["--company", "--out", "--as-of", "--open"],
  },
  // ===== RECURRING INVOICES (#118) =====
  {
    key: "recurring-invoice create",
    usage: "recurring-invoice create --company <path> --input <file.json>",
    description: "Opretter en gentagende fakturaskabelon (interval, kunde, linjer, moms, leveringsperiode).",
    allowedFlags: ["--company", "--input"],
    inputNotes: [
      "name: tekst",
      'interval: "monthly" | "quarterly" | "yearly"',
      "firstIssueDate: YYYY-MM-DD",
      "paymentTermsDays: heltal 0-365 (standard 30)",
      'deliveryPeriodMode: "issue_month" | "interval_window" | "none"',
      "invoice: faktura-payload (samme felter som invoice issue, uden issueDate/invoiceNumber)",
    ],
  },
  {
    key: "recurring-invoice generate",
    usage: "recurring-invoice generate --company <path> --template-id <n> --as-of <YYYY-MM-DD>",
    description: "Materialiserer deterministisk den faktura der er forfalden for skabelonen pr. --as-of (idempotent pr. periode).",
    allowedFlags: ["--company", "--template-id", "--as-of"],
  },
  {
    key: "recurring-invoice list",
    usage: "recurring-invoice list --company <path> [--include-inactive]",
    description: "Lister gentagende fakturaskabeloner.",
    allowedFlags: ["--company", "--include-inactive"],
  },
  // ===== END RECURRING INVOICES (#118) =====
  // ===== MAIL INTAKE (#122) =====
  {
    key: "mail-intake ingest",
    usage: "mail-intake ingest --company <path> --source <eml-file-or-maildrop-dir> [--metadata <file.json>] [--force]",
    description: "Indlæser bilag fra en lokal .eml-fil eller maildrop-mappe (første deterministiske intake-slice; ikke IMAP/hosted mailbox).",
    allowedFlags: ["--company", "--source", "--metadata", "--force"],
    examplePath: "examples/bilagsmail.metadata.json",
  },
  // ===== IMAP INTAKE (#181) =====
  {
    key: "imap-intake poll",
    usage:
      "imap-intake poll --company <path> [--metadata <file.json>] [--imap-host <host>] [--imap-port <n>] [--imap-username <user>] [--imap-mailbox <name>] [--since-uid <n>] [--force]",
    description:
      "Poller en hosted IMAP-postkasse og videresender nye beskeder til den eksisterende bilagsmail-pipeline (#122). Dedup er rerun-stabil; gentaget poll skaber ingen dubletter.",
    allowedFlags: [
      "--company", "--metadata", "--imap-host", "--imap-port",
      "--imap-username", "--imap-mailbox", "--since-uid", "--force",
    ],
    examplePath: "examples/bilagsmail.metadata.json",
    inputNotes: [
      "IMAP-credentials læses fra --imap-* flags eller RENTEMESTER_IMAP_* miljøvariabler",
      "RENTEMESTER_IMAP_PASSWORD er kun miljøvariabel — aldrig et CLI-flag eller i ledger",
      "Standard: TLS (IMAPS) på port 993, mailbox INBOX",
      "Dedup deler mail_intake_messages-tabellen med 'mail-intake ingest' (#122)",
    ],
  },
  // ===== END IMAP INTAKE (#181) =====
  // ===== MILEAGE LOG (#123) =====
  {
    key: "mileage log",
    usage:
      "mileage log --company <path> --date <YYYY-MM-DD> --purpose <text> --from <text> --to <text> --km <n> --vehicle <text> --driver <text> --rate-per-km <n> --rate-basis <text> [--rate-source <text>] [--notes <text>]",
    description:
      "Registrerer en append-only kørselspost i kørselsregnskabet. Satsen er bruger-oplyst og kilde-bakket; intet bogføres i finansen.",
    allowedFlags: [
      "--company", "--date", "--purpose", "--from", "--to", "--km", "--vehicle",
      "--driver", "--rate-per-km", "--rate-basis", "--rate-source", "--notes",
    ],
    inputNotes: [
      "rate-per-km og rate-basis skal være bruger-oplyst / kilde-bakket",
      "Rentemester fører kun loggen — skattemæssig behandling er brugerens/rådgiverens ansvar",
    ],
  },
  { key: "mileage list", usage: "mileage list --company <path>", description: "Lister registrerede kørselsposter.", allowedFlags: ["--company"] },
  { key: "mileage report", usage: "mileage report --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD>", description: "Deterministisk periode-rapport over kilometer og beløbsgrundlag.", allowedFlags: ["--company", "--from", "--to"] },
  { key: "mileage export", usage: "mileage export --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD> --out <dir>", description: "Skriver et deterministisk eksport-artifact (JSON + CSV) over kørselsregnskabet.", allowedFlags: ["--company", "--from", "--to", "--out"] },
  // ===== FIXED ASSETS (#124, #125) =====
  {
    key: "asset register",
    usage:
      "asset register --company <path> --name <text> --category <text> --acquisition-date <YYYY-MM-DD> --cost <n> --useful-life-months <n> --document-id <n> [--asset-account <konto>] [--depreciation-account <konto>] [--accumulated-account <konto>] [--note <text>]",
    description: "Registrerer et aktiv til afskrivning over tid med en lineær afskrivningsplan.",
    allowedFlags: ["--company", "--name", "--category", "--acquisition-date", "--cost", "--useful-life-months", "--document-id", "--asset-account", "--depreciation-account", "--accumulated-account", "--note"],
  },
  {
    key: "asset depreciate",
    usage: "asset depreciate --company <path> --asset-id <n> --period <n> --date <YYYY-MM-DD>",
    description: "Bogfører en periodes afskrivning for et aktiv (debet afskrivninger, kredit akkumulerede afskrivninger).",
    allowedFlags: ["--company", "--asset-id", "--period", "--date"],
  },
  {
    key: "asset write-off",
    usage:
      "asset write-off --company <path> --name <text> --category <text> --acquisition-date <YYYY-MM-DD> --cost <n> --document-id <n> --expense-account <konto> --date <YYYY-MM-DD> --threshold-source <text> --confirm yes [--payment-account <konto>] [--note <text>]",
    description: "Bogfører straksafskrivning af et mindre aktiv. Kræver --confirm yes og kildehenvisning til reglen; bruger/revisor ejer den skattemæssige vurdering.",
    allowedFlags: ["--company", "--name", "--category", "--acquisition-date", "--cost", "--document-id", "--expense-account", "--date", "--threshold-source", "--confirm", "--payment-account", "--note"],
  },
  { key: "asset register-report", usage: "asset register-report --company <path>", description: "Viser aktivregister med akkumulerede afskrivninger og bogført værdi.", allowedFlags: ["--company"] },
  // ===== END FIXED ASSETS (#124, #125) =====
  // ===== FINANCIAL STATEMENTS (#176) =====
  { key: "report trial-balance", usage: "report trial-balance --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD>", description: "Bygger en saldobalance med debet, kredit og saldo pr. konto for perioden.", allowedFlags: ["--company", "--from", "--to"] },
  { key: "report profit-loss", usage: "report profit-loss --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD>", description: "Bygger en resultatopgørelse (indtægter minus omkostninger) for perioden.", allowedFlags: ["--company", "--from", "--to"] },
  { key: "report balance", usage: "report balance --company <path> --as-of <YYYY-MM-DD>", description: "Bygger en balance (aktiver, passiver, egenkapital) på en given dato.", allowedFlags: ["--company", "--as-of"] },
  // ===== END FINANCIAL STATEMENTS (#176) =====
  // ===== VAT FILING (#178) =====
  {
    key: "vat momsangivelse",
    usage: "vat momsangivelse --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD>",
    description: "Bygger en indberetningsklar momsangivelse (SKAT-rubrikker + momstilsvar) for en lukket momsperiode. Kræver en lukket/indberettet vat_quarter-periode.",
    allowedFlags: ["--company", "--from", "--to"],
  },
  {
    key: "vat filing",
    usage: "vat filing --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD>",
    description: "Alias for 'vat momsangivelse': indberetningsklar momsangivelse for en lukket momsperiode.",
    allowedFlags: ["--company", "--from", "--to"],
  },
  // ===== END VAT FILING (#178) =====
  // ===== OPENING BALANCE (#179) =====
  {
    key: "opening-balance post",
    usage: "opening-balance post --company <path> --input <file.json>",
    description: "Bogfører virksomhedens primobalance som én balanceret, audited åbningspostering pr. en skæringsdato. Idempotent: præcis én primobalance pr. virksomhed.",
    allowedFlags: ["--company", "--input"],
    inputNotes: [
      "cutOverDate: YYYY-MM-DD (skæringsdato)",
      "lines: [{ accountNo, debitAmount | creditAmount, text? }]",
      "debitAmount/creditAmount: beløb i KRONER (decimal, fx 50000.00) — ikke øre",
      "Skal balancere: sum debet == sum kredit (kontrolleres internt med øre-præcision)",
      "note: valgfri tekst",
    ],
  },
  // ===== END OPENING BALANCE (#179) =====
  // ===== EMAIL DELIVERY (#180) =====
  {
    key: "invoice send",
    usage: "invoice send --company <path> (--document-id <n> | --invoice-number <no>) [--kind invoice|reminder] [--to <email>]",
    description: "Sender en udstedt faktura eller en betalingspaamindelse til kundens email via SMTP med PDF'en vedhaeftet, og logger afsendelsen append-only. SMTP-config laeses fra config/smtp.json; credentials gemmes aldrig i bogføringstilstanden. Idempotent: en identisk afsendelse genudsendes ikke.",
    allowedFlags: ["--company", "--document-id", "--invoice-number", "--kind", "--to"],
    inputNotes: [
      "SMTP-config (host, port, fromAddress, fromName, dryRun) laeses fra config/smtp.json",
      "--to overstyrer modtageren; ellers slaaes kundens email op fra kundekartoteket",
      "--kind reminder kraever at fakturaen er udstedt; standard er invoice",
    ],
  },
  // ===== END EMAIL DELIVERY (#180) =====
  // ===== GDPR (#184) =====
  {
    key: "gdpr export",
    usage: "gdpr export --company <path> (--cvr <DK...> | --name <text>) [--as-of <YYYY-MM-DD>]",
    description: "Samler alle persondata Rentemester har om en kunde/leverandør i én indsigtsrapport med opbevaringsvurdering. Read-only.",
    allowedFlags: ["--company", "--cvr", "--name", "--as-of"],
    inputNotes: [
      "Den registrerede identificeres med --cvr og/eller --name",
      "Hver post markeres med opbevaringsfrist og om den stadig er under bogføringspligt",
    ],
  },
  {
    key: "gdpr erase",
    usage: "gdpr erase --company <path> (--cvr <DK...> | --name <text>) [--as-of <YYYY-MM-DD>]",
    description: "Sletter/redigerer persondata der ikke længere er under bogføringsmæssig opbevaringspligt; afviser klart data der stadig skal opbevares. Append-only ledger og audit-kæde røres aldrig.",
    allowedFlags: ["--company", "--cvr", "--name", "--as-of"],
    inputNotes: [
      "Den registrerede identificeres med --cvr og/eller --name",
      "Poster under opbevaringsfrist afvises — bogføringsloven går forud for sletteret",
      "Sletning skrives som append-only tombstone; finansposteringer ændres ikke",
    ],
  },
  // ===== END GDPR (#184) =====
  // ===== ANNUAL REPORT (#177) =====
  {
    key: "report annual",
    usage: "report annual --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--ixbrl-out <file.xhtml>]",
    description: "Samler en arsrapport for regnskabsklasse B (resultatopgørelse, balance, noteskelet og ledelsespategning) for et lukket regnskabsaar og kan skrive en deterministisk iXBRL-fil. Rentemester forbereder; ejer/revisor gennemgar og indberetter.",
    allowedFlags: ["--company", "--from", "--to", "--ixbrl-out"],
    inputNotes: [
      "--from / --to afgrænser regnskabsaaret (skal være helt dækket af en lukket/indberettet periode)",
      "Kræver registreret CVR og balancerede bøger",
      "--ixbrl-out skriver en deterministisk iXBRL (inline-XBRL) XHTML-fil mod et afgrænset micro/small-taksonomi-udsnit",
    ],
  },
  // ===== END ANNUAL REPORT (#177) =====
  // ===== IMPORT FRAMEWORK (#185) =====
  {
    key: "import run",
    usage: "import run --company <path> --file <export-file> [--system <id>]",
    description: "Migrerer en virksomhed fra et andet bogføringssystem ind i Rentemester. Parser eksportfilen med den valgte per-system-parser og bogfører resultatet som virksomhedens primobalance (#179). Idempotent: præcis én import/primobalance pr. virksomhed.",
    allowedFlags: ["--company", "--file", "--system"],
    examplePath: "examples/import-synthetic.csv",
    exampleHint: "rentemester import run --example",
    inputNotes: [
      "--system vælger parseren; standard er 'synthetic-csv' (det indbyggede eksempel)",
      "Brug 'import systems' for at se tilgængelige parsere",
      "Eksportfilen skal balancere: sum debet == sum kredit (heltal øre)",
      "De rigtige e-conomic/Billy-parsere er en opfølgning — de kræver rigtige eksportfiler",
    ],
  },
  {
    key: "import systems",
    usage: "import systems [--format json|human]",
    description: "Lister de bogføringssystemer import-frameworket har en parser til. Read-only.",
    allowedFlags: [],
  },
  {
    key: "import archive",
    usage: "import archive --company <path> [--system <id>] [--year <YYYY>]",
    description: "Læser pre-cut-over arkivet: de tidligere regnskabsår fra et flerårigt eksport, der er gemt som read-only referencedata uden for hovedbogen (#197). Uden --year listes de arkiverede år; med --year vises årets fulde Posteringer/SaldoBalance.",
    allowedFlags: ["--company", "--system", "--year"],
    inputNotes: [
      "--system standard er 'dinero'",
      "Arkivet bogføres aldrig i den hash-kædede journal — kun cut-over året lander i hovedbogen",
    ],
  },
  {
    key: "import contacts",
    usage: "import contacts --company <path> --file <Kontakter.csv> [--enrich-cvr] [--default-role customer|vendor]",
    description: "Importerer en Dinero kontakt-eksport (Kontakter.csv) til kunde- og leverandørkartoteket. Hver kontakt klassificeres ud fra salgs-/købshistorik. Idempotent: allerede kendte kontakter springes over.",
    allowedFlags: ["--company", "--file", "--enrich-cvr", "--default-role"],
    inputNotes: [
      "--enrich-cvr beriger danske kontakter med stamdata fra CVR-registret (kræver CVR_USERNAME/CVR_PASSWORD)",
      "CSV-værdier vinder altid over CVR-data — berigelse udfylder kun tomme felter",
      "--default-role styrer kontakter uden salgs-/købshistorik (standard: vendor)",
      "Selve CSV-importen er deterministisk og offline; berigelse er det valgfri netværkslag",
    ],
  },
  // ===== END IMPORT FRAMEWORK (#185) =====
  // ===== RUNTIME AGENT (#183) =====
  {
    key: "agent run",
    usage: "agent run --company <slug|path> --as-of <YYYY-MM-DD> [--inbox <dir>] [--metadata-dir <dir>] [--bank-csv <file.csv>]",
    description:
      "Kører én deterministisk bogføringsloop for virksomheden: ingest bilag → bogfør det entydige → rut det usikre til exception-køen → afstem bank → tjek moms-/regnskabsår-deadlines → udskriv en slutrapport. Agenten gætter aldrig; alt usikkert bliver en exception. Samme fixture + samme --as-of giver identisk output.",
    allowedFlags: ["--company", "--as-of", "--inbox", "--metadata-dir", "--bank-csv"],
    inputNotes: [
      "--as-of er agentens eneste 'nu' — ingen wall-clock-afhængighed",
      "--inbox: mappe med bilag (ét dokument pr. fil) med parallel <stem>.json metadata",
      "--metadata-dir: hvor metadata-JSON ligger (standard: samme som --inbox)",
      "--bank-csv: bankudtog der importeres før match/afstemning",
      "Agenten bogfører som agent:rentemester-bookkeeper og handler kun inden for guardrails",
    ],
  },
  // ===== END RUNTIME AGENT (#183) =====
  // ===== REGULATORY COVERAGE =====
  {
    key: "reg coverage",
    usage: "reg coverage [--out <file.md>] [--format json|human]",
    description:
      "Måler regulatorisk dækning: hvor stor en del af de in-scope danske lovbestemmelser der er sporbart implementeret i regler/kode. Repo-statisk — kræver ingen --company. Fejler hvis en regel citerer en bestemmelse der ikke kan slås op (closure), hvis lovteksten har ændret sig siden citatet (drift), eller hvis scope-manifestet (sources/scope.yaml) er ufuldstændigt (scope).",
    allowedFlags: ["--out"],
    inputNotes: [
      "Læser rules/dk/*.yaml, sources/scope.yaml og kildekorpuset i sources/downloaded/ — ingen virksomhedsdata",
      "--out skriver den deterministiske Markdown-rapport (REGULATORY_COVERAGE.md-format)",
      "Dækning = in-scope operative bestemmelser citeret af mindst én regel / alle in-scope operative bestemmelser",
      "Scope afgrænses i sources/scope.yaml — en reviewbar manifest-fil",
    ],
  },
  {
    key: "reg citations",
    usage: "reg citations [--out <file.md>] [--format json|human]",
    description:
      "Skriver et deterministisk Markdown-review: for hver regel med citater vises reglens navn, forklaring og den ordrette lovtekst for hver citeret bestemmelse — så mapping regel→paragraf kan kontrolleres med øjnene. Repo-statisk.",
    allowedFlags: ["--out"],
    inputNotes: [
      "Læser rules/dk/*.yaml og kildekorpuset i sources/downloaded/ — ingen virksomhedsdata",
      "--out skriver review-filen; uden --out skrives den til stdout",
    ],
  },
  // ===== END REGULATORY COVERAGE =====
];

const SPEC_MAP = new Map(COMMAND_SPECS.map((spec) => [spec.key, spec]));

export function getCommandKey(cmd?: string, sub?: string) {
  if (!cmd) return "";
  return sub ? `${cmd} ${sub}` : cmd;
}

export function getCommandSpec(cmd?: string, sub?: string) {
  return SPEC_MAP.get(getCommandKey(cmd, sub));
}

export function renderGlobalUsage() {
  const lines = ["Rentemester v0.0.1", "", "Commands:"];
  for (const spec of COMMAND_SPECS) lines.push(`  ${spec.usage}`);
  lines.push("", "Global flags:", "  --help", "  --example", "  --format json|human", "  --json");
  return lines.join("\n");
}

export function renderCommandHelp(spec: CommandSpec) {
  const lines = [spec.description, "", "Brug:", `  rentemester ${spec.usage}`];
  if (spec.inputNotes?.length) {
    lines.push("", "Inputnoter:");
    for (const note of spec.inputNotes) lines.push(`  - ${note}`);
  }
  if (spec.examplePath) {
    lines.push("", "Eksempel:", `  ${spec.exampleHint ?? `rentemester ${spec.key} --example`}`, `  # Kilde: ${spec.examplePath}`);
  }
  lines.push("", "Tilladte flags:");
  for (const flag of [...spec.allowedFlags, ...GLOBAL_FLAGS]) lines.push(`  ${flag}`);
  return lines.join("\n");
}

export function validateCommandFlags(cmd: string | undefined, sub: string | undefined, flags: Iterable<string>) {
  const spec = getCommandSpec(cmd, sub);
  if (!spec) return [] as string[];
  const allowed = new Set([...spec.allowedFlags, ...GLOBAL_FLAGS]);
  const errors: string[] = [];
  for (const flag of flags) {
    if (allowed.has(flag)) continue;
    const suggestion = suggestFlag(flag, [...allowed]);
    errors.push(`Unknown flag ${flag} for ${spec.key}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`);
  }
  return errors;
}

function suggestFlag(input: string, candidates: string[]) {
  let best: { value: string; score: number } | null = null;
  for (const candidate of candidates) {
    const score = levenshtein(input, candidate);
    if (score > 3) continue;
    if (!best || score < best.score) best = { value: candidate, score };
  }
  return best?.value ?? null;
}

function levenshtein(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[a.length]![b.length]!;
}
