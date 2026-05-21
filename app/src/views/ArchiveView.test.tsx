import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import { ArchiveView } from "./ArchiveView";
import { renderAt } from "../test/render";
import { archive, fiscalYears, mockFetch } from "../test/fixtures";

function route(over: { fy?: any; arc?: any } = {}) {
  return {
    "GET /api/companies/acme-aps/fiscal-years": {
      fiscalYears: over.fy ?? fiscalYears(),
    },
    "GET /api/companies/acme-aps/archive/2025": {
      archive: archive(over.arc ?? {}),
    },
  };
}

function renderView(routePath = "/companies/acme-aps/arkiv?year=2025") {
  return renderAt(<ArchiveView />, {
    route: routePath,
    path: "/companies/:slug/arkiv",
  });
}

describe("ArchiveView — Arkiv", () => {
  test("shows the read-only archived-year banner and SaldoBalance", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByText(/Arkiveret regnskabsår 2025 — skrivebeskyttet/),
    ).toBeInTheDocument();
    // The SaldoBalance table lists every archived account.
    expect(screen.getByRole("cell", { name: "Omsætning" })).toBeInTheDocument();
    expect(
      screen.getByRole("cell", { name: "Vareforbrug" }),
    ).toBeInTheDocument();
  });

  test("the SaldoBalance heading carries the year", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByRole("heading", { name: "Saldobalance 2025" }),
    ).toBeInTheDocument();
  });

  test("shows the archived posting summary", async () => {
    mockFetch(route());
    renderView();
    const postings = (
      await screen.findByRole("heading", { name: "Posteringer" })
    ).closest(".status-card")!;
    expect(
      within(postings as HTMLElement).getByText("84"),
    ).toBeInTheDocument();
  });

  test("picking a live year points the user back to its live views", async () => {
    mockFetch(route());
    renderView("/companies/acme-aps/arkiv?year=2026");
    expect(
      await screen.findByText(/Regnskabsår 2026 er ikke arkiveret/),
    ).toBeInTheDocument();
  });

  test("a company with no archive shows the empty state", async () => {
    mockFetch(
      route({
        fy: fiscalYears([
          { label: "2026", start: "2026-01-01", end: "2026-12-31", source: "live" },
        ]),
      }),
    );
    renderView("/companies/acme-aps/arkiv");
    expect(
      await screen.findByText(/Ingen arkiverede regnskabsår/),
    ).toBeInTheDocument();
  });
});
