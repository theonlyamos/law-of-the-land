import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notFound: vi.fn(),
  search: new URLSearchParams(),
  useQuery: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ chatId: "7bb69b0e-cc01-4b98-ac37-6c8ca7e44c4c" }),
  useSearchParams: () => mocks.search,
  notFound: mocks.notFound,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: mocks.useQuery,
}));
vi.mock("@/components/chat/chat-workspace", () => ({
  ChatWorkspace: (props: Record<string, unknown>) => <output aria-label="workspace-props">{JSON.stringify(props)}</output>,
}));

import ChatPage from "./page";

beforeEach(() => {
  mocks.search = new URLSearchParams("q=Question&jurisdiction=jurisdiction-ghana&country=GH");
  mocks.notFound.mockReset();
  mocks.useQuery.mockReset();
  mocks.useQuery.mockReturnValue(null);
});
afterEach(cleanup);

describe("chat route jurisdiction selection", () => {
  it("passes only the stable jurisdiction ID to the workspace", () => {
    render(<ChatPage />);
    expect(screen.getByRole("status", { name: "workspace-props" })).toHaveTextContent(
      '"initialJurisdiction":"jurisdiction-ghana"',
    );
    expect(screen.getByRole("status", { name: "workspace-props" })).not.toHaveTextContent(
      "initialCountry",
    );
  });

  it("rejects a new routed chat without a stable jurisdiction", async () => {
    mocks.search = new URLSearchParams("q=Question");

    render(<ChatPage />);

    await waitFor(() => expect(mocks.notFound).toHaveBeenCalled());
  });
});
