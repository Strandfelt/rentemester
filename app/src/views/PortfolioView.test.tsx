import { describe, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { PortfolioView } from "./PortfolioView";
import { renderAt } from "../test/render";
import { mockFetch, summary } from "../test/fixtures";

function portfolioRoute(companies: ReturnType<typeof summary>[]) {
  return {
    "GET /api/portfolio": {
      portfolio: {
        workspace: "/ws",
        asOf: "2026-05-20",
        companyCount: companies.length,
        totals: {},
        companies,
      },
    },
  };
}

describe("PortfolioView", () => {
  test("an empty workspace renders the first-run onboarding", async () => {
    mockFetch(portfolioRoute([]));
    renderAt(<PortfolioView />);
    expect(await screen.findByText(/Velkommen til Rentemester/i)).toBeInTheDocument();
    expect(
      screen.getByRole("form", { name: /Opret virksomhed/i }),
    ).toBeInTheDocument();
  });

  test("renders one card per company, attention first", async () => {
    mockFetch(
      portfolioRoute([
        summary({ slug: "calm-aps", name: "Calm ApS" }),
        summary({ slug: "broken-aps", name: "Broken ApS", auditChainOk: false }),
      ]),
    );
    renderAt(<PortfolioView />);
    const headings = await screen.findAllByRole("heading", { level: 3 });
    // "needs attention" sorts the broken company first.
    expect(headings[0]).toHaveTextContent("Broken ApS");
    expect(headings[1]).toHaveTextContent("Calm ApS");
  });

  test("shows the attention summary count", async () => {
    mockFetch(
      portfolioRoute([
        summary({ slug: "a", name: "A", overdueInvoiceCount: 1 }),
        summary({ slug: "b", name: "B" }),
      ]),
    );
    renderAt(<PortfolioView />);
    expect(await screen.findByText(/1 kræver opmærksomhed/i)).toBeInTheDocument();
  });

  test("surfaces an API error with a retry affordance", async () => {
    mockFetch({});
    renderAt(<PortfolioView />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Prøv igen/i })).toBeInTheDocument();
  });
});
