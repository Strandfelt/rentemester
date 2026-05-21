import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import { ObligationsView } from "./ObligationsView";
import { renderAt } from "../test/render";
import { obligations, mockFetch } from "../test/fixtures";

function route(over = {}) {
  return {
    "GET /api/companies/acme-aps/obligations": {
      obligations: obligations(over),
    },
  };
}

function renderView() {
  return renderAt(<ObligationsView />, {
    route: "/companies/acme-aps/forpligtelser",
    path: "/companies/:slug/forpligtelser",
  });
}

describe("ObligationsView — Forpligtelser", () => {
  test("lists each obligation with its label and amount", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByRole("heading", { name: "Acme ApS" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Moms — 1. halvår 2026")).toBeInTheDocument();
    expect(screen.getByText("Skyldig selskabsskat")).toBeInTheDocument();
    expect(
      screen.getByText("Kreditorer (leverandørgæld)"),
    ).toBeInTheDocument();
  });

  test("shows a derived deadline and a dateless dash", async () => {
    mockFetch(route());
    renderView();
    expect(await screen.findByText("2026-09-01")).toBeInTheDocument();
    expect(screen.getByText("2027-11-01")).toBeInTheDocument();
    // The creditor row has no known deadline — shown as an em dash.
    const creditorRow = screen
      .getByText("Kreditorer (leverandørgæld)")
      .closest("tr")!;
    expect(
      within(creditorRow as HTMLElement).getByText("Ingen frist"),
    ).toBeInTheDocument();
  });

  test("shows the total owed summary", async () => {
    mockFetch(route());
    renderView();
    // "Skyldige beløb i alt" labels both the summary card and the totals row.
    expect(
      (await screen.findAllByText("Skyldige beløb i alt")).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/7\.527,66/).length).toBeGreaterThan(0);
  });

  test("a company that owes nothing shows the empty state", async () => {
    mockFetch(route({ obligations: [], totalOwed: 0 }));
    renderView();
    expect(
      await screen.findByText(/Ingen forpligtelser/),
    ).toBeInTheDocument();
  });

  test("an archived year shows an honest 'not available' state", async () => {
    mockFetch(route({ archived: true, selectedYear: "2025" }));
    renderView();
    expect(
      await screen.findByText(
        /Forpligtelser er ikke tilgængelige for 2025/,
      ),
    ).toBeInTheDocument();
  });
});
