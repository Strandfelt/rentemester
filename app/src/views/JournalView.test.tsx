import { describe, expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JournalView } from "./JournalView";
import { renderAt } from "../test/render";
import { journal, mockFetch } from "../test/fixtures";

function route(over = {}) {
  return {
    "GET /api/companies/acme-aps/journal": { journal: journal(over) },
  };
}

function renderView() {
  return renderAt(<JournalView />, {
    route: "/companies/acme-aps/posteringer",
    path: "/companies/:slug/posteringer",
  });
}

describe("JournalView — Posteringer", () => {
  test("lists the posted journal entries", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByRole("heading", { name: "Acme ApS" }),
    ).toBeInTheDocument();
    expect(screen.getByText("B-2026-0001")).toBeInTheDocument();
    expect(screen.getByText("Salg af ydelse")).toBeInTheDocument();
  });

  test("clicking an entry drills into its debit/credit lines", async () => {
    mockFetch(route());
    renderView();
    const summary = await screen.findByRole("button", {
      name: /Salg af ydelse/,
    });
    expect(screen.queryByText("Omsætning")).not.toBeInTheDocument();
    await userEvent.click(summary);
    expect(await screen.findByText("Omsætning")).toBeInTheDocument();
    expect(screen.getByText("Salgsmoms")).toBeInTheDocument();
  });

  test("the company sub-nav exposes the new tabs", async () => {
    mockFetch(route());
    renderView();
    const bankTab = await screen.findByRole("link", { name: "Bank" });
    expect(bankTab).toHaveAttribute(
      "href",
      expect.stringContaining("/companies/acme-aps/bank"),
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

  test("an archived year shows the arkiv notice", async () => {
    mockFetch(route({ archived: true, selectedYear: "2025", entries: [] }));
    renderView();
    expect(
      await screen.findByText(/Regnskabsår 2025 er arkiveret/),
    ).toBeInTheDocument();
  });

  test("an ?account= filter fetches the filtered journal and names the account", async () => {
    mockFetch(
      route({
        accountFilter: { accountNo: "55000", name: "Bank" },
      }),
    );
    renderAt(<JournalView />, {
      route: "/companies/acme-aps/posteringer?account=55000",
      path: "/companies/:slug/posteringer",
    });
    // The filter banner names the account.
    expect(await screen.findByText("Bank")).toBeInTheDocument();
    expect(screen.getByText("55000")).toBeInTheDocument();
    // The fetch carried the account param.
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c) => String(c[0]).includes("account=55000"))).toBe(
      true,
    );
    // "Vis alle posteringer" clears the filter.
    expect(
      screen.getByRole("button", { name: "Vis alle posteringer" }),
    ).toBeInTheDocument();
  });
});
