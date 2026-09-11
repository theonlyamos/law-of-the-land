import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrganizationForm } from "./organization-form";
const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("convex/react", () => ({ useMutation: () => save }));
afterEach(() => {
  cleanup();
  save.mockReset();
});
it("creates an organization without a slug and preserves input on failure", async () => {
  save
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce("organization-id");
  const onSaved = vi.fn();
  render(<OrganizationForm onSaved={onSaved} />);
  fireEvent.change(screen.getByLabelText("Organization name"), {
    target: { value: "Northbridge" },
  });
  fireEvent.change(screen.getByLabelText("Organization type"), {
    target: { value: "university" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create organization" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Organization name")).toHaveValue("Northbridge");
  fireEvent.click(screen.getByRole("button", { name: "Create organization" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith("organization-id"));
  expect(save.mock.calls[0][0]).toEqual(save.mock.calls[1][0]);
  expect(save.mock.calls[0][0]).toMatchObject({
    name: "Northbridge",
    class: "university",
  });
  expect(screen.queryByLabelText(/slug/i)).not.toBeInTheDocument();
});
