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
    const vat = screen.getByText("Moms").closest(".status-card")!;
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

  test("an archived year shows the arkiv notice", async () => {
    mockFetch(overviewRoute({ archived: true, selectedYear: "2025" }));
    renderDashboard();
    expect(
      await screen.findByText(/Regnskabsår 2025 er arkiveret/),
    ).toBeInTheDocument();
  });
});
