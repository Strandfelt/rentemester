import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import { DashboardView } from "./DashboardView";
import { renderAt } from "../test/render";
import { dashboard, mockFetch } from "../test/fixtures";

function dashRoute(over = {}) {
  return {
    "GET /api/companies/acme-aps/dashboard": { dashboard: dashboard(over) },
  };
}

describe("DashboardView", () => {
  test("renders the company header and headline tiles", async () => {
    mockFetch(dashRoute());
    renderAt(<DashboardView />, {
      route: "/companies/acme-aps",
      path: "/companies/:slug",
    });
    expect(
      await screen.findByRole("heading", { name: "Acme ApS" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Åbne tilgodehavender/i)).toBeInTheDocument();
    expect(screen.getByText(/Revisionskæde/i)).toBeInTheDocument();
  });

  test("lists open invoices in a table", async () => {
    mockFetch(
      dashRoute({
        invoices: {
          count: 1,
          openTotal: 50000,
          rows: [
            {
              invoiceNumber: "2026-0001",
              customerName: "Kunde A/S",
              dueDate: "2026-06-01",
              openBalance: 50000,
            },
          ],
        },
      }),
    );
    renderAt(<DashboardView />, {
      route: "/companies/acme-aps",
      path: "/companies/:slug",
    });
    expect(await screen.findByText("2026-0001")).toBeInTheDocument();
    expect(screen.getByText("Kunde A/S")).toBeInTheDocument();
  });

  test("flags a broken audit chain", async () => {
    mockFetch(dashRoute({ audit: { ok: false, entryCount: 2, firstError: "x" } }));
    renderAt(<DashboardView />, {
      route: "/companies/acme-aps",
      path: "/companies/:slug",
    });
    const tiles = await screen.findAllByText(/Revisionskæde/i);
    const tile = tiles[0].closest(".tile")!;
    expect(within(tile as HTMLElement).getByText("Brudt")).toBeInTheDocument();
  });
});
