import { describe, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ManageCompanyView } from "./ManageCompanyView";
import { renderAt } from "../test/render";
import { mockFetch } from "../test/fixtures";

function companiesRoute(archived = false) {
  return {
    "GET /api/companies": {
      workspace: "/ws",
      count: 1,
      companies: [
        {
          slug: "acme-aps",
          name: "Acme ApS",
          createdAt: "2026-01-01T00:00:00.000Z",
          archived,
        },
      ],
    },
  };
}

describe("ManageCompanyView", () => {
  test("renders the rename form prefilled with the current name", async () => {
    mockFetch(companiesRoute());
    renderAt(<ManageCompanyView />, {
      route: "/companies/acme-aps/manage",
      path: "/companies/:slug/manage",
    });
    const input = (await screen.findByLabelText(
      /Visningsnavn/i,
    )) as HTMLInputElement;
    expect(input.value).toBe("Acme ApS");
  });

  test("PATCHes a new display name", async () => {
    mockFetch({
      ...companiesRoute(),
      "PATCH /api/companies/acme-aps": {
        company: { slug: "acme-aps", name: "Acme Holding ApS", archived: false },
      },
    });
    renderAt(<ManageCompanyView />, {
      route: "/companies/acme-aps/manage",
      path: "/companies/:slug/manage",
    });
    const input = await screen.findByLabelText(/Visningsnavn/i);
    await userEvent.clear(input);
    await userEvent.type(input, "Acme Holding ApS");
    await userEvent.click(screen.getByRole("button", { name: /Gem navn/i }));
    expect(await screen.findByText(/Visningsnavn opdateret/i)).toBeInTheDocument();
  });

  test("offers archive for an active company and restore for an archived one", async () => {
    mockFetch(companiesRoute(false));
    renderAt(<ManageCompanyView />, {
      route: "/companies/acme-aps/manage",
      path: "/companies/:slug/manage",
    });
    expect(
      await screen.findByRole("button", { name: /Arkivér virksomhed/i }),
    ).toBeInTheDocument();
  });

  test("404s for an unknown slug", async () => {
    mockFetch(companiesRoute());
    renderAt(<ManageCompanyView />, {
      route: "/companies/ghost/manage",
      path: "/companies/:slug/manage",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/findes ikke/i);
  });
});
