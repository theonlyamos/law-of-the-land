import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
  overview: undefined as unknown,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: () => mocks.overview,
  useMutation: (reference: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(reference);
    if (!mocks.mutations.has(name)) mocks.mutations.set(name, vi.fn().mockResolvedValue(null));
    return mocks.mutations.get(name);
  },
}));
import { MemorySettings } from "./memory-settings";

afterEach(() => { cleanup(); mocks.mutations.clear(); });

describe("memory settings", () => {
  it("shows remembered facts with why they were saved, and lets the person forget, add and pause", async () => {
    mocks.overview = {
      available: true,
      enabled: true,
      scopes: [
        { scope: "personal", name: "Personal", facts: [
          { id: "fact-1", type: "role", value: "tenant", source: "stated", quote: "I rent a flat", confirmedAt: Date.UTC(2026, 9, 1) },
        ] },
        { scope: "org-1", organizationId: "org-1", name: "Acme", facts: [] },
      ],
    };
    render(<MemorySettings />);

    expect(screen.getByText("Memory is on")).toBeVisible();
    expect(screen.getByText("Tenant", { selector: "span" })).toBeVisible();
    expect(screen.getByText(/You said · “I rent a flat”/u)).toBeVisible();
    expect(screen.getByText("Used only in Acme chats.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Forget Tenant" }));
    await waitFor(() => expect(mocks.mutations.get("profileMemory:removeFact")).toHaveBeenCalledWith({ factId: "fact-1" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Remember this" })[1]);
    await waitFor(() => expect(mocks.mutations.get("profileMemory:addFact")).toHaveBeenCalledWith({ type: "role", value: "tenant", organizationId: "org-1" }));

    fireEvent.click(screen.getByRole("button", { name: "Pause memory" }));
    await waitFor(() => expect(mocks.mutations.get("profileMemory:setEnabled")).toHaveBeenCalledWith({ enabled: false }));
  });

  it("asks before forgetting everything", async () => {
    mocks.overview = { available: true, enabled: false, scopes: [{ scope: "personal", name: "Personal", facts: [] }] };
    render(<MemorySettings />);
    expect(screen.getByText("Memory is paused")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Clear all memory" }));
    expect(mocks.mutations.get("profileMemory:clearAll")).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Forget everything" }));
    await waitFor(() => expect(mocks.mutations.get("profileMemory:clearAll")).toHaveBeenCalledWith({}));
  });
});
