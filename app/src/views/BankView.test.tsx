import { describe, expect, test } from "vitest";
import { screen } from "@testing-library/react";
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

  test("an archived year shows the arkiv notice", async () => {
    mockFetch(
      route({ archived: true, selectedYear: "2025", transactions: [] }),
    );
    renderView();
    expect(
      await screen.findByText(/Regnskabsår 2025 er arkiveret/),
    ).toBeInTheDocument();
  });
});
