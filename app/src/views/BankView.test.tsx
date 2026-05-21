import { describe, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BankView } from "./BankView";
import { renderAt } from "../test/render";
import { bank, mockFetch } from "../test/fixtures";

function route(over = {}) {
  return {
    "GET /api/companies/acme-aps/bank": { bank: bank(over) },
  };
}

function renderView() {
  return renderAt(<BankView />, {
    route: "/companies/acme-aps/bank",
    path: "/companies/:slug/bank",
  });
}

describe("BankView — Bank", () => {
  test("shows the booked balance and the bank account", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByRole("heading", { name: "Acme ApS" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Bogført saldo")).toBeInTheDocument();
    expect(screen.getByText(/Danske Bank/)).toBeInTheDocument();
  });

  test("lists transactions with their reconciliation status", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByText("Indbetaling faktura 1001"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Afstemt/)).toBeInTheDocument();
    expect(screen.getByText("Uafstemt")).toBeInTheDocument();
  });

  test("shows the booked-vs-actual difference prominently at the top", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByRole("heading", { name: "Acme ApS" }),
    ).toBeInTheDocument();
    // The gap banner names the difference and the actual statement balance.
    expect(screen.getByText("Difference")).toBeInTheDocument();
    expect(screen.getByText(/17\.733,28/)).toBeInTheDocument();
    expect(screen.getByText("Faktisk saldo")).toBeInTheDocument();
  });

  test("a reconciled account shows the afstemt banner", async () => {
    mockFetch(route({ actualBalance: 41388.03, difference: 0 }));
    renderView();
    expect(
      await screen.findByText(/Kontoudtog og bogført saldo stemmer/),
    ).toBeInTheDocument();
  });

  test("without an imported statement the banner says so", async () => {
    mockFetch(route({ actualBalance: null, difference: null }));
    renderView();
    expect(
      await screen.findByText(/Intet kontoudtog importeret for/),
    ).toBeInTheDocument();
  });

  test("an archived year shows the arkiv notice", async () => {
    mockFetch(
      route({ archived: true, selectedYear: "2025", transactions: [] }),
    );
    renderView();
    expect(
      await screen.findByText(/Bank er ikke tilgængelig for 2025/),
    ).toBeInTheDocument();
  });

  // #213 slice 2 — the bank-CSV-import write action.

  test("a live year offers an Importér kontoudtog action", async () => {
    mockFetch(route());
    renderView();
    await screen.findByRole("heading", { name: "Acme ApS" });
    expect(
      screen.getByRole("button", { name: "Importér kontoudtog" }),
    ).toBeInTheDocument();
  });

  test("an archived year offers no import action", async () => {
    mockFetch(
      route({ archived: true, selectedYear: "2025", transactions: [] }),
    );
    renderView();
    await screen.findByText(/Bank er ikke tilgængelig for 2025/);
    expect(
      screen.queryByRole("button", { name: "Importér kontoudtog" }),
    ).not.toBeInTheDocument();
  });

  test("clicking Importér kontoudtog opens the import modal", async () => {
    mockFetch(route());
    renderView();
    await userEvent.click(
      await screen.findByRole("button", { name: "Importér kontoudtog" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Importér kontoudtog" }),
    ).toBeInTheDocument();
  });
});
