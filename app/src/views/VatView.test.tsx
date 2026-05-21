import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import { VatView } from "./VatView";
import { renderAt } from "../test/render";
import { vat, mockFetch } from "../test/fixtures";

function route(over = {}) {
  return {
    "GET /api/companies/acme-aps/vat": { vat: vat(over) },
  };
}

function renderView() {
  return renderAt(<VatView />, {
    route: "/companies/acme-aps/moms",
    path: "/companies/:slug/moms",
  });
}

describe("VatView — Moms", () => {
  test("shows the output, input and payable VAT figures", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByRole("heading", { name: "Acme ApS" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Salgsmoms (udgående moms)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Købsmoms (indgående moms)"),
    ).toBeInTheDocument();
    const payable = (await screen.findByText("Moms at betale")).closest("tr")!;
    expect(
      within(payable as HTMLElement).getByText(/3\.371,00/),
    ).toBeInTheDocument();
  });

  test("shows the period label", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByText(/1\. halvår 2026/),
    ).toBeInTheDocument();
  });

  test("an archived year shows an honest 'not available' state", async () => {
    mockFetch(route({ archived: true, selectedYear: "2025" }));
    renderView();
    expect(
      await screen.findByText(/Moms er ikke tilgængelig for 2025/),
    ).toBeInTheDocument();
  });
});
