import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import { MultiYearView } from "./MultiYearView";
import { renderAt } from "../test/render";
import { multiYear, mockFetch } from "../test/fixtures";

function route(over = {}) {
  return {
    "GET /api/companies/acme-aps/multi-year": { multiYear: multiYear(over) },
  };
}

function renderView() {
  return renderAt(<MultiYearView />, {
    route: "/companies/acme-aps/fleraar",
    path: "/companies/:slug/fleraar",
  });
}

describe("MultiYearView — Flerårsoversigt", () => {
  test("renders a key-figures row per fiscal year", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByRole("heading", { name: "Acme ApS" }),
    ).toBeInTheDocument();
    // Every year — archive 2023–25 and live 2026 — has a table row.
    for (const year of ["2023", "2024", "2025", "2026"]) {
      expect(screen.getByRole("cell", { name: new RegExp(year) })).toBeInTheDocument();
    }
  });

  test("marks archived years with an arkiv tag", async () => {
    mockFetch(route());
    renderView();
    const row2025 = (
      await screen.findByRole("cell", { name: /2025/ })
    ).closest("tr")!;
    expect(within(row2025 as HTMLElement).getByText("arkiv")).toBeInTheDocument();
  });

  test("shows the omsætning / udgifter / resultat columns", async () => {
    mockFetch(route());
    renderView();
    expect(await screen.findByText("Omsætning")).toBeInTheDocument();
    expect(screen.getByText("Udgifter")).toBeInTheDocument();
    expect(screen.getByText("Resultat")).toBeInTheDocument();
  });

  test("renders the trend chart", async () => {
    mockFetch(route());
    const { container } = renderView();
    await screen.findByRole("heading", { name: "Acme ApS" });
    expect(container.querySelector(".pnl-chart canvas")).toBeTruthy();
  });

  test("marks the live/current year as '(år til dato)'", async () => {
    mockFetch(route());
    renderView();
    const row2026 = (
      await screen.findByRole("cell", { name: /2026/ })
    ).closest("tr")!;
    expect(
      within(row2026 as HTMLElement).getByText("(år til dato)"),
    ).toBeInTheDocument();
    // The full archived years carry no such marker.
    const row2025 = (
      await screen.findByRole("cell", { name: /2025/ })
    ).closest("tr")!;
    expect(
      within(row2025 as HTMLElement).queryByText("(år til dato)"),
    ).not.toBeInTheDocument();
  });

  test("an empty company shows the no-years state", async () => {
    mockFetch(route({ years: [] }));
    renderView();
    expect(
      await screen.findByText(/Ingen regnskabsår/),
    ).toBeInTheDocument();
  });
});
