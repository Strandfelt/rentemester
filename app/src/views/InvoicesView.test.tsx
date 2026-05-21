import { describe, expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InvoicesView } from "./InvoicesView";
import { renderAt } from "../test/render";
import { invoices, mockFetch } from "../test/fixtures";

function route(over = {}) {
  return {
    "GET /api/companies/acme-aps/invoices": { invoices: invoices(over) },
  };
}

function renderView() {
  return renderAt(<InvoicesView />, {
    route: "/companies/acme-aps/fakturaer",
    path: "/companies/:slug/fakturaer",
  });
}

describe("InvoicesView — Fakturaer", () => {
  test("lists the issued invoices with their status", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByRole("heading", { name: "Acme ApS" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2026-00001")).toBeInTheDocument();
    expect(screen.getByText("Betalt")).toBeInTheDocument();
    expect(screen.getByText(/Forfalden/)).toBeInTheDocument();
  });

  test("shows a graceful empty state when there are no invoices", async () => {
    mockFetch(route({ invoices: [], totalGross: 0, totalOpen: 0, overdueCount: 0 }));
    renderView();
    expect(
      await screen.findByText(/Ingen fakturaer endnu/),
    ).toBeInTheDocument();
  });

  test("the fiscal-year selector reloads for the chosen year", async () => {
    mockFetch(route());
    renderView();
    const select = await screen.findByLabelText("Vælg regnskabsår");
    await userEvent.selectOptions(select, "2025");
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const lastUrl = String(calls[calls.length - 1]![0]);
    expect(lastUrl).toContain("year=2025");
  });

  test("an archived year shows the arkiv notice", async () => {
    mockFetch(route({ archived: true, selectedYear: "2025", invoices: [] }));
    renderView();
    expect(
      await screen.findByText(/Regnskabsår 2025 er arkiveret/),
    ).toBeInTheDocument();
  });
});
