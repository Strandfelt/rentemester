import { describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "./ConfirmDialog";
import { ApiError } from "../lib/api";

function noop() {}

describe("ConfirmDialog", () => {
  test("renders the title, body and confirm label", () => {
    render(
      <ConfirmDialog
        title="Løs opgave"
        body={<p>Markér opgaven som løst.</p>}
        confirmLabel="Løs opgave"
        onConfirm={async () => {}}
        onClose={noop}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Løs opgave" })).toBeInTheDocument();
    expect(screen.getByText("Markér opgaven som løst.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Løs opgave" })).toBeInTheDocument();
  });

  test("passes the note text to onConfirm", async () => {
    const onConfirm = vi.fn(async () => {});
    render(
      <ConfirmDialog
        title="Løs opgave"
        body="x"
        confirmLabel="Løs"
        noteLabel="Note"
        onConfirm={onConfirm}
        onClose={noop}
      />,
    );
    await userEvent.type(screen.getByLabelText("Note"), "Afstemt manuelt");
    await userEvent.click(screen.getByRole("button", { name: "Løs" }));
    expect(onConfirm).toHaveBeenCalledWith("Afstemt manuelt");
  });

  test("closes via onClose after a successful confirm", async () => {
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        title="Løs opgave"
        body="x"
        confirmLabel="Løs"
        onConfirm={async () => {}}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Løs" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test("Annullér closes without confirming", async () => {
    const onConfirm = vi.fn(async () => {});
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        title="Løs opgave"
        body="x"
        confirmLabel="Løs"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Annullér" }));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("a 409 conflict is rendered as a kind lock banner, modal stays open", async () => {
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        title="Løs opgave"
        body="x"
        confirmLabel="Løs"
        onConfirm={async () => {
          throw new ApiError("conflict", "Bogføring er låst: backup overskredet.", 409);
        }}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Løs" }));
    expect(await screen.findByText("Bogføringen er låst")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a non-conflict error is rendered as an error banner", async () => {
    render(
      <ConfirmDialog
        title="Løs opgave"
        body="x"
        confirmLabel="Løs"
        onConfirm={async () => {
          throw new ApiError("bad_request", "Ugyldig handling.", 400);
        }}
        onClose={noop}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Løs" }));
    expect(await screen.findByText("Ugyldig handling.")).toBeInTheDocument();
  });
});
