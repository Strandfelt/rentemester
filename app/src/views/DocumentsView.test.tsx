import { describe, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { DocumentsView } from "./DocumentsView";
import { renderAt } from "../test/render";
import { documents, mockFetch } from "../test/fixtures";

const FISCAL_YEARS = {
  slug: "acme-aps",
  years: [
    { label: "2026", start: "2026-01-01", end: "2026-12-31", source: "live" },
    { label: "2025", start: null, end: null, source: "archive" },
  ],
};

function route(over = {}) {
  return {
    "GET /api/companies/acme-aps/documents": { documents: documents(over) },
    "GET /api/companies/acme-aps/fiscal-years": { fiscalYears: FISCAL_YEARS },
  };
}

function renderView() {
  return renderAt(<DocumentsView />, {
    route: "/companies/acme-aps/bilag",
    path: "/companies/:slug/bilag",
  });
}

describe("DocumentsView — Bilag", () => {
  test("lists ingested documents with their details", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByRole("heading", { name: "Acme ApS" }),
    ).toBeInTheDocument();
    expect(screen.getByText("DOC-2026-000001")).toBeInTheDocument();
    expect(screen.getByText("Leverandør ApS")).toBeInTheDocument();
  });

  test("shows the linked journal entry for a booked document", async () => {
    mockFetch(route());
    renderView();
    expect(await screen.findByText(/B-2026-0002/)).toBeInTheDocument();
  });

  test("shows an unbooked marker when no journal entry is linked", async () => {
    mockFetch(
      route({
        documents: [
          {
            id: 9,
            documentNo: "DOC-2026-000009",
            source: "email",
            filename: "kvittering.pdf",
            documentType: "purchase_sale",
            supplierName: "Anden ApS",
            invoiceNo: null,
            invoiceDate: null,
            amountIncVat: null,
            currency: "DKK",
            status: "ingested",
            voucherRef: null,
            journalEntryNo: null,
            journalEntryId: null,
          },
        ],
        linkedCount: 0,
        unlinkedCount: 1,
      }),
    );
    renderView();
    expect(await screen.findByText("Ikke bogført")).toBeInTheDocument();
  });
});
