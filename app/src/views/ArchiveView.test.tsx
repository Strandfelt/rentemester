import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import { ArchiveView } from "./ArchiveView";
import { renderAt } from "../test/render";
import { fiscalYears, mockFetch } from "../test/fixtures";

function route(over: { fy?: any } = {}) {
  return {
    "GET /api/companies/acme-aps/fiscal-years": {
      fiscalYears: over.fy ?? fiscalYears(),
    },
  };
}

function renderView(routePath = "/companies/acme-aps/arkiv") {
  return renderAt(<ArchiveView />, {
    route: routePath,
    path: "/companies/:slug/arkiv",
  });
}

describe("ArchiveView — Om arkivet", () => {
  test("explains that the archive is the read-only Dinero #197 import", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByText(
        /Det arkiverede regnskab er skrivebeskyttet/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Dinero-eksport \(#197\)/)).toBeInTheDocument();
  });

  test("lists each archived year with links into the core views", async () => {
    mockFetch(route());
    renderView();
    const row2025 = (
      await screen.findByRole("cell", { name: /2025/ })
    ).closest("tr")!;
    expect(
      within(row2025 as HTMLElement).getByRole("link", { name: "Saldobalance" }),
    ).toHaveAttribute("href", "/companies/acme-aps/saldobalance?year=2025");
    expect(
      within(row2025 as HTMLElement).getByRole("link", {
        name: "Resultatopgørelse",
      }),
    ).toHaveAttribute(
      "href",
      "/companies/acme-aps/resultatopgorelse?year=2025",
    );
  });

  test("a company with no archive shows the empty state", async () => {
    mockFetch(
      route({
        fy: fiscalYears([
          { label: "2026", start: "2026-01-01", end: "2026-12-31", source: "live" },
        ]),
      }),
    );
    renderView();
    expect(
      await screen.findByText(/Ingen arkiverede regnskabsår/),
    ).toBeInTheDocument();
  });
});
