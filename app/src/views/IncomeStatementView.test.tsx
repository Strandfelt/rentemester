import { describe, expect, test, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IncomeStatementView } from "./IncomeStatementView";
import { renderAt } from "../test/render";
import { incomeStatement, mockFetch } from "../test/fixtures";

function route(over = {}) {
  return {
    "GET /api/companies/acme-aps/income-statement": {
      incomeStatement: incomeStatement(over),
    },
  };
}

function renderView() {
  return renderAt(<IncomeStatementView />, {
    route: "/companies/acme-aps/resultatopgorelse",
    path: "/companies/:slug/resultatopgorelse",
  });
}

describe("IncomeStatementView — Resultatopgørelse", () => {
  test("renders the income and expense section headings", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByRole("heading", { name: "Acme ApS" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Indtægter")).toBeInTheDocument();
    expect(screen.getByText("Udgifter")).toBeInTheDocument();
  });

  test("shows the ground-truth result figure", async () => {
    mockFetch(route());
    renderView();
    const result = (await screen.findByText("Årets resultat")).closest("tr")!;
    expect(
      within(result as HTMLElement).getByText(/13\.234,82/),
    ).toBeInTheDocument();
  });

  test("lists account lines with their amounts", async () => {
    mockFetch(route());
    renderView();
    expect(await screen.findByText("Omsætning")).toBeInTheDocument();
    expect(screen.getByText("Vareforbrug")).toBeInTheDocument();
  });

  test("the company sub-nav links to the other views", async () => {
    mockFetch(route());
    renderView();
    const balanceTab = await screen.findByRole("link", { name: "Balance" });
    expect(balanceTab).toHaveAttribute(
      "href",
      expect.stringContaining("/companies/acme-aps/balance"),
    );
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

  test("account rows drill into that account's postings, carrying the year", async () => {
    mockFetch(route());
    renderView();
    const link = await screen.findByRole("link", { name: "1000" });
    expect(link).toHaveAttribute(
      "href",
      "/companies/acme-aps/posteringer?year=2026&account=1000",
    );
  });
});
