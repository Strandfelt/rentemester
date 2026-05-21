import { describe, expect, test, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DashboardView } from "./DashboardView";
import { renderAt } from "../test/render";
import { overview, mockFetch } from "../test/fixtures";

// The P&L chart needs a real <canvas> 2D context, which happy-dom lacks —
// stub it so the view's data wiring is what the specs exercise.
vi.mock("../components/PnlChart", () => ({
  PnlChart: () => <div data-testid="pnl-chart" />,
}));

function overviewRoute(over = {}) {
  return {
    "GET /api/companies/acme-aps/overview": { overview: overview(over) },
  };
}

function renderDashboard() {
  return renderAt(<DashboardView />, {
    route: "/companies/acme-aps",
    path: "/companies/:slug",
  });
}

describe("DashboardView — Overblik", () => {
  test("renders the company header and the three KPI cards", async () => {
    mockFetch(overviewRoute());
    renderDashboard();
    expect(
      await screen.findByRole("heading", { name: "Acme ApS" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Omsætning")).toBeInTheDocument();
    expect(screen.getByText("Udgifter")).toBeInTheDocument();
    expect(screen.getByText("Resultat")).toBeInTheDocument();
  });

  test("shows the ground-truth result figure", async () => {
    mockFetch(overviewRoute());
    renderDashboard();
    const result = (await screen.findByText("Resultat")).closest(".kpi")!;
    expect(
      within(result as HTMLElement).getByText(/13\.234,82/),
    ).toBeInTheDocument();
  });

  test("renders the P&L chart and the VAT status card", async () => {
    mockFetch(overviewRoute());
    renderDashboard();
    expect(await screen.findByTestId("pnl-chart")).toBeInTheDocument();
    const vat = screen
      .getByRole("heading", { name: "Moms" })
      .closest(".status-card")!;
    expect(within(vat as HTMLElement).getByText(/3\.371,00/)).toBeInTheDocument();
    expect(
      within(vat as HTMLElement).getByText(/1\. halvår 2026/),
    ).toBeInTheDocument();
  });

  test("lists recent entries when present", async () => {
    mockFetch(
      overviewRoute({
        recentEntries: [
          {
            id: 1,
            entryNo: "2026-0001",
            date: "2026-02-27",
            text: "Momsafregning",
            amount: 5334,
          },
        ],
      }),
    );
    renderDashboard();
    expect(await screen.findByText("Momsafregning")).toBeInTheDocument();
  });

  test("the fiscal-year selector reloads the overview for the chosen year", async () => {
    mockFetch(overviewRoute());
    renderDashboard();
    const select = await screen.findByLabelText("Vælg regnskabsår");
    await userEvent.selectOptions(select, "2025");
    // The last fetch call must carry the chosen year.
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const lastUrl = String(calls[calls.length - 1]![0]);
    expect(lastUrl).toContain("year=2025");
  });

  test("the Bank card shows the actual balance, booked balance and difference", async () => {
    mockFetch(overviewRoute());
    renderDashboard();
    await screen.findByRole("heading", { name: "Acme ApS" });
    const bankCard = screen
      .getByRole("heading", { name: "Bank" })
      .closest(".status-card")!;
    // Headline figure is the actual statement balance.
    const figure = bankCard.querySelector(".status-figure")!;
    expect(figure.textContent).toMatch(/23\.654,75/);
    // The note carries the booked figure and the unreconciled gap.
    const note = bankCard.querySelector(".status-note")!;
    expect(note.textContent).toMatch(/Bogført.*41\.388,03/);
    expect(
      within(bankCard as HTMLElement).getByText(/ikke afstemt/),
    ).toBeInTheDocument();
  });

  test("groups exceptions into one Danish, clickable summary line", async () => {
    mockFetch(
      overviewRoute({
        exceptions: {
          count: 362,
          rows: [],
          groups: [
            {
              type: "UNMATCHED_BANK_TRANSACTION",
              count: 362,
              severity: "medium",
              label: "362 banktransaktioner mangler afstemning",
              link: "bank",
            },
          ],
        },
      }),
    );
    renderDashboard();
    const line = await screen.findByText(
      "362 banktransaktioner mangler afstemning",
    );
    expect(line).toBeInTheDocument();
    // The line links to the Bank view.
    expect(line.closest("a")).toHaveAttribute(
      "href",
      "/companies/acme-aps/bank",
    );
  });

  test("an archived year renders the P&L overview under a read-only banner", async () => {
    mockFetch(
      overviewRoute({
        archived: true,
        archivedSource: "dinero",
        selectedYear: "2025",
        vat: null,
      }),
    );
    renderDashboard();
    expect(
      await screen.findByText(/Arkiveret regnskabsår 2025 — skrivebeskyttet/),
    ).toBeInTheDocument();
    // The KPI cards still render from the archived figures.
    expect(screen.getByText("Omsætning")).toBeInTheDocument();
    expect(screen.getByText("Resultat")).toBeInTheDocument();
    // Live-only data is honestly marked unavailable rather than faked.
    expect(
      screen.getByText(/ikke tilgængelige for et arkiveret regnskabsår/),
    ).toBeInTheDocument();
  });

  test("shows the 'Senest bogført pr.' date near the period header", async () => {
    mockFetch(overviewRoute({ lastPostedDate: "2026-04-30" }));
    renderDashboard();
    expect(
      await screen.findByText(/Senest bogført pr\. 2026-04-30/),
    ).toBeInTheDocument();
  });

  test("renders the bruttomargin and egenkapitalandel nøgletal", async () => {
    mockFetch(
      overviewRoute({
        keyFigures: { bruttomargin: 0.7423, egenkapitalandel: 0.9186 },
      }),
    );
    renderDashboard();
    expect(await screen.findByText("Bruttomargin")).toBeInTheDocument();
    expect(screen.getByText("Egenkapitalandel")).toBeInTheDocument();
    const margin = screen.getByText("Bruttomargin").closest(".key-figure")!;
    expect(
      within(margin as HTMLElement).getByText(/74,2\s*%/),
    ).toBeInTheDocument();
  });

  test("the KPI cards drill into the Resultatopgørelse, carrying the year", async () => {
    mockFetch(overviewRoute());
    renderDashboard();
    const omsaetning = (await screen.findByText("Omsætning")).closest("a")!;
    expect(omsaetning).toHaveAttribute(
      "href",
      "/companies/acme-aps/resultatopgorelse?year=2026",
    );
  });

  test("the Bank card drills into the Bank view", async () => {
    mockFetch(overviewRoute());
    renderDashboard();
    const bankCard = (
      await screen.findByRole("heading", { name: "Bank" })
    ).closest("a")!;
    expect(bankCard).toHaveAttribute("href", "/companies/acme-aps/bank?year=2026");
  });
});
