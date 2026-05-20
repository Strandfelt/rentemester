import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompanyForm } from "./CompanyForm";
import { mockFetch } from "../test/fixtures";

describe("CompanyForm", () => {
  test("POSTs the entered company and reports the created slug", async () => {
    mockFetch({
      "POST /api/companies": { company: { slug: "gamma-aps", name: "Gamma ApS" } },
    });
    const onCreated = vi.fn();
    render(<CompanyForm onCreated={onCreated} />);

    await userEvent.type(screen.getByLabelText(/Virksomhedsnavn/i), "Gamma ApS");
    await userEvent.click(screen.getByRole("button", { name: /Opret virksomhed/i }));

    expect(onCreated).toHaveBeenCalledWith("gamma-aps");
  });

  test("blocks submit on an empty name", async () => {
    const onCreated = vi.fn();
    render(<CompanyForm onCreated={onCreated} />);
    await userEvent.click(screen.getByRole("button", { name: /Opret virksomhed/i }));
    expect(onCreated).not.toHaveBeenCalled();
  });

  test("renders a backend conflict error inline", async () => {
    mockFetch({
      "POST /api/companies": {
        __error: { code: "conflict", message: "findes allerede" },
      },
    });
    render(<CompanyForm onCreated={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/Virksomhedsnavn/i), "Acme ApS");
    await userEvent.click(screen.getByRole("button", { name: /Opret virksomhed/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/findes allerede/i);
  });
});
