import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  ensureSession: vi.fn(),
  appendMessages: vi.fn(),
  unifiedEnabled: false,
  resolvedSelection: null as null | {
    id: string; name: string; slug: string; kind: "geographic" | "organizational";
    isDefault: boolean; legacyCountryCode?: string;
  },
  catalog: undefined as undefined | Array<{
    code: string;
    name: string;
    slug: string;
    isDefault: boolean;
  }>,
  session: null as null | { country: string | null; title: string; jurisdictionId?: string | null; jurisdictionName?: string | null; jurisdictionKind?: "geographic" | "organizational" | null },
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
  mocks.appendMessages.mockReset();
  mocks.ensureSession.mockResolvedValue(undefined);
  mocks.appendMessages.mockResolvedValue(undefined);
  mocks.unifiedEnabled = false;
  mocks.resolvedSelection = null;
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
    if (name === "jurisdictions:isUnifiedJurisdictionsEnabled") return mocks.unifiedEnabled;
    if (name === "jurisdictions:resolveResearchSelection") return args === "skip" ? undefined : mocks.resolvedSelection;
    if (name === "jurisdictions:listPublicEnabled") return mocks.catalog;
    if (name === "chats:getByExternalId") return args === "skip" ? undefined : mocks.session;
    return undefined;
  });
  mocks.useMutation.mockImplementation((reference) => {
    const name = getFunctionName(reference);
    if (name === "chats:ensure") return mocks.ensureSession;
    if (name === "chats:appendMessages") return mocks.appendMessages;
    return vi.fn();
  });
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

  it("creates and persists a code-less organization chat by stable ID with safe citations", async () => {
    mocks.unifiedEnabled = true;
    mocks.resolvedSelection = {
      id: "organization-jurisdiction",
      name: "Private University",
      slug: "private-university",
      kind: "organizational",
      isDefault: false,
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: "governed context",
        correlationToken: "token",
        jurisdictionId: "organization-jurisdiction",
        partialCoverage: [{ jurisdictionId: "ancestor", name: "Ghana", kind: "geographic", relation: "organizational_geography" }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: "Governed answer",
        citations: [{ label: "[University policy](https://untrusted.example)", jurisdictionId: "organization-jurisdiction", jurisdictionName: "Private University", jurisdictionKind: "organizational", relation: "selected" }],
      }), { status: 200 })));

    render(<ChatWorkspace
      chatId="7bb69b0e-cc01-4b98-ac37-6c8ca7e44c4c"
      initialQuery="What is the policy?"
      initialJurisdiction="organization-jurisdiction"
    />);

    await waitFor(() => expect(mocks.ensureSession).toHaveBeenCalledWith({
      externalId: "7bb69b0e-cc01-4b98-ac37-6c8ca7e44c4c",
      jurisdictionId: "organization-jurisdiction",
      jurisdictionName: "Private University",
      jurisdictionKind: "organizational",
    }));
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalled());
    const searchBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    const chatBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body as string);
    expect(searchBody).toEqual({ query: "What is the policy?", jurisdictionId: "organization-jurisdiction" });
    expect(chatBody).toMatchObject({ jurisdictionId: "organization-jurisdiction", context: "governed context" });
    const sources = await screen.findByRole("region", { name: "Sources" });
    expect(sources).toHaveTextContent("[University policy](https://untrusted.example)");
    expect(sources.querySelector("a")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Partial coverage: this answer could not include Ghana.");
  });

  it("does not call chat or persist when search returns a different stable jurisdiction", async () => {
    mocks.unifiedEnabled = true;
    mocks.resolvedSelection = {
      id: "selected-jurisdiction",
      name: "Selected University",
      slug: "selected-university",
      kind: "organizational",
      isDefault: false,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      result: "governed context",
      correlationToken: "token",
      jurisdictionId: "different-jurisdiction",
    }), { status: 200 })));

    render(<ChatWorkspace
      chatId="7bb69b0e-cc01-4b98-ac37-6c8ca7e44c4c"
      initialQuery="What is the policy?"
      initialJurisdiction="selected-jurisdiction"
    />);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("The jurisdiction selection could not be verified. Please try again.")).toBeVisible());
    expect(mocks.appendMessages).not.toHaveBeenCalled();
  });

  it("uses one unavailable state and performs no work for an unresolved route selection", async () => {
    mocks.unifiedEnabled = true;
    mocks.resolvedSelection = null;
    render(<ChatWorkspace
      chatId="7bb69b0e-cc01-4b98-ac37-6c8ca7e44c4c"
      initialQuery="What is the policy?"
      initialJurisdiction="missing-jurisdiction"
    />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That jurisdiction is not available for research.",
    );
    expect(mocks.ensureSession).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
