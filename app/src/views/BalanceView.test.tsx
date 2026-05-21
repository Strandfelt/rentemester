import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import { BalanceView } from "./BalanceView";
import { renderAt } from "../test/render";
import { balance, mockFetch } from "../test/fixtures";

function route(over = {}) {
  return {
    "GET /api/companies/acme-aps/balance": { balance: balance(over) },
  };
}

function renderView() {
  return renderAt(<BalanceView />, {
    route: "/companies/acme-aps/balance",
    path: "/companies/:slug/balance",
  });
}

describe("BalanceView — Balance", () => {
  test("renders the three balance sheet sections", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByRole("heading", { name: "Acme ApS" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Aktiver")).toBeInTheDocument();
    expect(screen.getByText("Passiver")).toBeInTheDocument();
    expect(screen.getByText("Egenkapital")).toBeInTheDocument();
  });

  test("shows the balanced confirmation when the sheet balances", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByText(/Balancen stemmer/),
    ).toBeInTheDocument();
  });

  test("warns when the sheet does not balance", async () => {
    mockFetch(route({ balanced: false }));
    renderView();
    expect(
      await screen.findByText(/Balancen stemmer ikke/),
    ).toBeInTheDocument();
  });

  test("surfaces the period result on the equity side", async () => {
    mockFetch(route());
    renderView();
    expect(await screen.findByText("Årets resultat")).toBeInTheDocument();
  });

  test("the total liabilities + equity figure is rendered", async () => {
    mockFetch(route());
    renderView();
    const total = (
      await screen.findByText("Passiver og egenkapital i alt")
    ).closest("tr")!;
    expect(
      within(total as HTMLElement).getByText(/41\.388,03/),
    ).toBeInTheDocument();
  });
});
