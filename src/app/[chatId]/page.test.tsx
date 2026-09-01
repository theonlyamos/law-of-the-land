import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ search: new URLSearchParams(), useQuery: vi.fn() }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ chatId: "7bb69b0e-cc01-4b98-ac37-6c8ca7e44c4c" }),
  useSearchParams: () => mocks.search,
  notFound: vi.fn(),
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
  mocks.useQuery.mockReset();
  mocks.useQuery.mockReturnValue(null);
});
afterEach(cleanup);

describe("chat route jurisdiction selection", () => {
  it("passes the stable ID and optional matching legacy snapshot to the workspace", () => {
    render(<ChatPage />);
    expect(screen.getByRole("status", { name: "workspace-props" })).toHaveTextContent(
      '"initialJurisdiction":"jurisdiction-ghana"',
    );
    expect(screen.getByRole("status", { name: "workspace-props" })).toHaveTextContent(
      '"initialCountry":"GH"',
    );
  });
});
