import { describe, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

function renderView(route = "/companies/acme-aps/bilag") {
  return renderAt(<DocumentsView />, {
    route,
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

  test("shows the linked entry's text and amount so the row is informative", async () => {
    mockFetch(route());
    renderView();
    // The voucher's posting text — what the receipt is for.
    expect(
      await screen.findByText("Køb af kontorartikler"),
    ).toBeInTheDocument();
  });

  test("falls back to the linked entry's total when the document amount is blank", async () => {
    mockFetch(
      route({
        documents: [
          {
            id: 5,
            documentNo: "DOC-2026-000005",
            source: "dinero-import",
            filename: "bilag.pdf",
            documentType: "purchase_sale",
            supplierName: null,
            invoiceNo: null,
            invoiceDate: null,
            amountIncVat: null,
            currency: "DKK",
            status: "ingested",
            voucherRef: "5",
            journalEntryNo: "B-2026-0005",
            journalEntryId: 5,
            journalEntryText: "Kontorartikler hos Lev ApS",
            journalEntryTotal: 412.5,
          },
        ],
        linkedCount: 1,
        unlinkedCount: 0,
      }),
    );
    renderView();
    expect(
      await screen.findByText("Kontorartikler hos Lev ApS"),
    ).toBeInTheDocument();
    expect(screen.getByText(/412,50/)).toBeInTheDocument();
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
            journalEntryText: null,
            journalEntryTotal: null,
          },
        ],
        linkedCount: 0,
        unlinkedCount: 1,
      }),
    );
    renderView();
    expect(await screen.findByText("Ikke bogført")).toBeInTheDocument();
  });

  // #213 slice 3 — the document-intake write action.

  test("a live year offers an Indlæs bilag action", async () => {
    mockFetch(route());
    renderView();
    await screen.findByRole("heading", { name: "Acme ApS" });
    expect(
      screen.getByRole("button", { name: "Indlæs bilag" }),
    ).toBeInTheDocument();
  });

  test("an archived year offers no intake action", async () => {
    mockFetch(route());
    // The URL pins the archived year 2025; its fiscal-year source is `archive`.
    renderView("/companies/acme-aps/bilag?year=2025");
    await screen.findByRole("heading", { name: "Acme ApS" });
    expect(
      screen.queryByRole("button", { name: "Indlæs bilag" }),
    ).not.toBeInTheDocument();
  });

  test("clicking Indlæs bilag opens the intake modal", async () => {
    mockFetch(route());
    renderView();
    await userEvent.click(
      await screen.findByRole("button", { name: "Indlæs bilag" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Indlæs bilag" }),
    ).toBeInTheDocument();
  });
});
