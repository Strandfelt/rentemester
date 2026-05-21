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

  test("shows the quarterly period label", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByText(/Q2 2026/),
    ).toBeInTheDocument();
  });

  test("shows the full SKAT momsangivelse rubrics", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByText(/SKAT-rubrikker/),
    ).toBeInTheDocument();
    // The foreign-trade rubrics the static figures lacked are now present.
    expect(screen.getByText("Salgsmoms")).toBeInTheDocument();
    expect(
      screen.getByText(/Rubrik A — varer og ydelser købt i udlandet/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Rubrik B — varer og ydelser solgt til udlandet/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Rubrik C — øvrige momsfrie salg/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Moms af ydelseskøb i udlandet med omvendt betalingspligt/,
      ),
    ).toBeInTheDocument();
    // The momstilsvar row carries the filing figure.
    const tilsvar = screen.getByText("Momstilsvar").closest("tr")!;
    expect(
      within(tilsvar as HTMLElement).getByText(/3\.621,00/),
    ).toBeInTheDocument();
  });

  test("an archived year shows an honest 'not available' state", async () => {
    mockFetch(route({ archived: true, selectedYear: "2025" }));
    renderView();
    expect(
      await screen.findByText(/Moms er ikke tilgængelig for 2025/),
    ).toBeInTheDocument();
  });

  // #271: a bad-debt write-off books a debit on the output-VAT account. The
  // VAT card must surface that relief on its own clearly-labelled line —
  // never let it drag the headline salgsmoms negative.
  test("a bad-debt adjustment is its own line, salgsmoms stays positive", async () => {
    mockFetch(
      route({
        outputVat: 250,
        outputVatAdjustment: -300,
        inputVat: 100,
        payable: -150,
      }),
    );
    renderView();
    // Salgsmoms keeps the genuine, positive VAT on sales.
    const salgsmomsRow = (
      await screen.findByText("Salgsmoms (udgående moms)")
    ).closest("tr")!;
    expect(
      within(salgsmomsRow as HTMLElement).getByText(/250,00/),
    ).toBeInTheDocument();
    // It is NOT shown as a confusing negative salgsmoms.
    expect(
      within(salgsmomsRow as HTMLElement).queryByText(/-250,00/),
    ).not.toBeInTheDocument();
    // The bad-debt relief sits on its own dedicated line.
    const adjustmentRow = screen
      .getByText(/Regulering for tab på debitorer/)
      .closest("tr")!;
    expect(
      within(adjustmentRow as HTMLElement).getByText(/-300,00/),
    ).toBeInTheDocument();
  });

  test("no adjustment line is shown when there is no bad-debt write-off", async () => {
    mockFetch(route({ outputVatAdjustment: 0 }));
    renderView();
    await screen.findByText("Salgsmoms (udgående moms)");
    expect(
      screen.queryByText(/Regulering for tab på debitorer/),
    ).not.toBeInTheDocument();
  });
});
