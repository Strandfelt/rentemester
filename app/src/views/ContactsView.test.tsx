import { describe, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContactsView } from "./ContactsView";
import { renderAt } from "../test/render";
import { contacts, mockFetch } from "../test/fixtures";

function route(over = {}) {
  return {
    "GET /api/companies/acme-aps/contacts": { contacts: contacts(over) },
  };
}

function renderView() {
  return renderAt(<ContactsView />, {
    route: "/companies/acme-aps/kontakter",
    path: "/companies/:slug/kontakter",
  });
}

describe("ContactsView — Kontakter", () => {
  test("lists customers and vendors", async () => {
    mockFetch(route());
    renderView();
    expect(
      await screen.findByRole("heading", { name: "Acme ApS" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Kunde A/S")).toBeInTheDocument();
    expect(screen.getByText("Leverandør ApS")).toBeInTheDocument();
    expect(screen.getByText("Standardmoms")).toBeInTheDocument();
  });

  test("shows a graceful empty state when there are no contacts", async () => {
    mockFetch(route({ customers: [], vendors: [] }));
    renderView();
    expect(
      await screen.findByText(/Ingen kontakter endnu/),
    ).toBeInTheDocument();
  });

  test("the company sub-nav exposes the Kontakter tab", async () => {
    mockFetch(route());
    renderView();
    const tab = await screen.findByRole("link", { name: "Kontakter" });
    expect(tab).toHaveAttribute(
      "href",
      expect.stringContaining("/companies/acme-aps/kontakter"),
    );
  });

  test("offers an Importér action", async () => {
    mockFetch(route());
    renderView();
    await screen.findByRole("heading", { name: "Acme ApS" });
    expect(
      screen.getByRole("button", { name: "Importér" }),
    ).toBeInTheDocument();
  });

  test("clicking Importér opens the file-import modal", async () => {
    mockFetch(route());
    renderView();
    await userEvent.click(
      await screen.findByRole("button", { name: "Importér" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Importér fil" }),
    ).toBeInTheDocument();
  });
});
