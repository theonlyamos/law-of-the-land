import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  ensureSession: vi.fn(),
  catalog: undefined as undefined | Array<{
    code: string;
    name: string;
    slug: string;
    isDefault: boolean;
  }>,
  session: null as null | { country: string; title: string },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span aria-label={alt} />,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useMutation: (reference: unknown) => mocks.useMutation(reference),
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    loadMore: vi.fn(),
  }),
  useQuery: mocks.useQuery,
}));

import { ChatWorkspace } from "./chat-workspace";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  mocks.push.mockReset();
  mocks.replace.mockReset();
  mocks.useQuery.mockReset();
  mocks.useMutation.mockReset();
  mocks.ensureSession.mockReset();
  mocks.ensureSession.mockResolvedValue(undefined);
  mocks.catalog = [
    {
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      isDefault: true,
    },
    {
      code: "NG",
      name: "Nigeria",
      slug: "nigeria",
      isDefault: false,
    },
  ];
  mocks.session = null;
  mocks.useQuery.mockImplementation((reference, args) => {
    const name = getFunctionName(reference);
    if (name === "jurisdictions:listPublicEnabled") return mocks.catalog;
    if (name === "chats:getByExternalId") return args === "skip" ? undefined : mocks.session;
    return undefined;
  });
  mocks.useMutation.mockImplementation((reference) =>
    getFunctionName(reference) === "chats:ensure" ? mocks.ensureSession : vi.fn(),
  );
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      result: "context",
      correlationToken: "token",
      jurisdictionCode: "NG",
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: "answer" }), { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("new-chat jurisdiction selector", () => {
  it("renders the governed catalog and selects its configured default", async () => {
    render(<ChatWorkspace chatId={null} initialQuery={null} />);

    const selector = await screen.findByRole("combobox", { name: "Research jurisdiction" });
    await waitFor(() => expect(selector).toHaveValue("GH"));
    expect(screen.getByRole("option", { name: "Nigeria" })).toBeVisible();
  });

  it("explains when no governed jurisdiction is available for a new chat", () => {
    mocks.catalog = [];

    render(<ChatWorkspace chatId={null} initialQuery={null} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "No jurisdictions are currently available",
    );
    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("waits for the governed catalog before creating a routed chat", async () => {
    mocks.catalog = undefined;
    const props = {
      chatId: "7bb69b0e-cc01-4b98-ac37-6c8ca7e44c4c",
      initialQuery: "What is the law?",
      initialCountry: "NG",
    };
    const view = render(<ChatWorkspace {...props} />);

    expect(mocks.ensureSession).not.toHaveBeenCalled();

    mocks.catalog = [
      {
        code: "NG",
        name: "Nigeria",
        slug: "nigeria",
        isDefault: true,
      },
    ];
    view.rerender(<ChatWorkspace {...props} />);

    await waitFor(() => expect(mocks.ensureSession).toHaveBeenCalledWith({
      externalId: props.chatId,
      country: "NG",
    }));
  });

  it("keeps an existing chat bound to its stored jurisdiction", async () => {
    mocks.session = { country: "NG", title: "Nigerian tenancy" };

    render(
      <ChatWorkspace
        chatId="7bb69b0e-cc01-4b98-ac37-6c8ca7e44c4c"
        initialQuery="What is the law?"
        initialCountry="GH"
      />,
    );

    expect(screen.queryByRole("combobox", { name: "Research jurisdiction" })).not.toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(mocks.ensureSession).not.toHaveBeenCalled();
  });
});
