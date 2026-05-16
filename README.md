# Rentemester

Agent-first bookkeeping system for Danish micro-businesses.

AI acts. Rules decide. Ledger enforces.

## Current status

v0 scaffold: Bun CLI, SQLite ledger schema, company volume layout, audit hash verification, Docker runtime, deterministic bank import, deterministic bank reconciliation, deterministic Danish invoice validation, deterministic supporting-document ingestion, compliant journal posting, append-only journal reversal, deterministic VAT period reporting, and EU service reverse-charge posting.

## Quick start

```bash
bun run src/cli.ts init --company ./companies/demo
bun run src/cli.ts system healthcheck --company ./companies/demo
bun run src/cli.ts accounts list --company ./companies/demo
bun run src/cli.ts audit verify --company ./companies/demo
bun run src/cli.ts bank import --company ./companies/demo --file ./examples/bank-transactions.csv
bun run src/cli.ts reconcile bank --company ./companies/demo --from 2026-05-01 --to 2026-05-31
bun run src/cli.ts invoice validate --input ./examples/full-invoice.dk.json
bun run src/cli.ts documents ingest --company ./companies/demo --file ./examples/vendor-invoice.txt --metadata ./examples/vendor-invoice.metadata.json
bun run src/cli.ts journal post --company ./companies/demo --input ./examples/journal-entry.expense.json
bun run src/cli.ts vat report --company ./companies/demo --from 2026-05-01 --to 2026-05-31
bun run src/cli.ts documents ingest --company ./companies/demo --file ./examples/eu-service-invoice.txt --metadata ./examples/eu-service-invoice.metadata.json
bun run src/cli.ts vat post-eu-service-purchase --company ./companies/demo --input ./examples/eu-service-purchase.json
bun run src/cli.ts journal reverse --company ./companies/demo --entry-id 1 --date 2026-05-17 --reason "Wrong booking period"
```

## Docker

```bash
docker build -t rentemester:latest .
docker run --rm -v "$PWD/companies/demo:/company" rentemester:latest init --company /company
docker run --rm -v "$PWD/companies/demo:/company" rentemester:latest system healthcheck --company /company
```
