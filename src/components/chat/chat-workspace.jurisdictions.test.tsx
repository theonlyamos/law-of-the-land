import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  useQuery: vi.fn(),
  usePaginatedQuery: vi.fn(),
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
  session: null as null | { country: string | null; title: string; jurisdictionId?: string | null; jurisdictionName?: string | null; jurisdictionKind?: "geographic" | "organizational" | null; jurisdictionContract?: "legacy" | "unified" | null },
  sessions: [] as Array<{ id: string; title: string; lastMessage: string; timestamp: number; messageCount: number }>,
  messages: [] as Array<{ storageId: string; clientId: string | null; role: "user" | "assistant"; content: string; createdAt: number; creationTime: number }>,
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
  usePaginatedQuery: mocks.usePaginatedQuery,
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
  mocks.usePaginatedQuery.mockReset();
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
  mocks.sessions = [];
  mocks.messages = [];
  mocks.usePaginatedQuery.mockImplementation((reference) => ({
    results: getFunctionName(reference) === "chats:list" ? mocks.sessions : mocks.messages,
    status: "Exhausted",
    loadMore: vi.fn(),
  }));
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
  it("normalizes escaped paragraph breaks before rendering persisted assistant Markdown", async () => {
    mocks.session = { country: "GH", title: "Formatted answer" };
    mocks.messages = [{
      storageId: "assistant-message",
      clientId: "assistant-client",
      role: "assistant",
      content: "Tenant rights:\\n\\n1. **First right**\\n\\n2. Second right",
      createdAt: 1,
      creationTime: 1,
    }];

    render(<ChatWorkspace chatId="markdown-chat" initialQuery={null} />);

    const firstRight = await screen.findByText("First right");
    const list = firstRight.closest("ol");
    expect(list).not.toBeNull();
    expect(within(list!).getAllByRole("listitem")).toHaveLength(2);
  });

  it("batches streamed text into the next animation frame", async () => {
    let frame!: FrameRequestCallback;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let finishStream!: () => void;
    const encoder = new TextEncoder();
    const streamedChatResponse = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"delta","text":"The streamed "}\n'));
        controller.enqueue(encoder.encode('{"type":"delta","text":"answer."}\n'));
        finishStream = () => {
          controller.enqueue(encoder.encode('{"type":"done","result":"The streamed answer."}\n'));
          controller.close();
        };
      },
    }), { headers: { "content-type": "application/x-ndjson" } });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: "context",
        correlationToken: "token",
        jurisdictionCode: "GH",
      }), { status: 200 }))
      .mockResolvedValueOnce(streamedChatResponse));

    render(<ChatWorkspace chatId="batched-stream" initialQuery="What is the rule?" />);

    await waitFor(() => expect(requestAnimationFrame).toHaveBeenCalledTimes(1));
    expect(mocks.appendMessages).not.toHaveBeenCalled();

    await act(async () => frame(performance.now()));
    expect(await screen.findByText("The streamed answer.")).toBeVisible();

    finishStream();
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalled());
  });

  it("renders streamed answer text before persisting the terminal response", async () => {
    let finishStream!: () => void;
    const encoder = new TextEncoder();
    const streamedChatResponse = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"delta","text":"The streamed "}\n'));
        finishStream = () => {
          controller.enqueue(encoder.encode('{"type":"done","result":"The streamed answer."}\n'));
          controller.close();
        };
      },
    }), { headers: { "content-type": "application/x-ndjson" } });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: "context",
        correlationToken: "token",
        jurisdictionCode: "GH",
      }), { status: 200 }))
      .mockResolvedValueOnce(streamedChatResponse));

    render(<ChatWorkspace chatId="streamed-chat" initialQuery="What is the rule?" />);

    expect(await screen.findByText("The streamed")).toBeVisible();
    expect(mocks.appendMessages).not.toHaveBeenCalled();

    finishStream();

    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalled());
    expect(mocks.appendMessages.mock.calls[0][0].messages[1].content).toBe("The streamed answer.");
  });

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
    let resolveEnsure!: () => void;
    mocks.ensureSession.mockReturnValue(new Promise<void>((resolve) => { resolveEnsure = resolve; }));
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
        citationClaim: "c".repeat(43),
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
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.appendMessages).not.toHaveBeenCalled();
    resolveEnsure();
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalled());
    const searchBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    const chatBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body as string);
    expect(searchBody).toEqual({ query: "What is the policy?", jurisdictionId: "organization-jurisdiction" });
    expect(chatBody).toMatchObject({
      jurisdictionId: "organization-jurisdiction",
      context: "governed context",
      externalId: "7bb69b0e-cc01-4b98-ac37-6c8ca7e44c4c",
      assistantClientId: expect.any(String),
    });
    const append = mocks.appendMessages.mock.calls[0][0];
    expect(append.messages[1]).toMatchObject({
      role: "assistant",
      clientId: chatBody.assistantClientId,
      citationClaim: "c".repeat(43),
    });
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

  it("keeps a stored ID authoritative when its immutable country snapshot differs from the current code", async () => {
    mocks.unifiedEnabled = true;
    mocks.session = {
      country: "GH",
      title: "Stored snapshot",
      jurisdictionId: "stable-jurisdiction",
      jurisdictionName: "Ghana",
      jurisdictionKind: "geographic",
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: "governed context",
        correlationToken: "token",
        jurisdictionId: "stable-jurisdiction",
        legacyCountryCode: "NG",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: "Current answer" }), { status: 200 })));

    render(<ChatWorkspace
      chatId="stored-chat"
      initialQuery="What changed?"
      initialJurisdiction="stable-jurisdiction"
      initialCountry="GH"
    />);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalled());
    const searchBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    const chatBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body as string);
    expect(searchBody).toEqual({ query: "What changed?", jurisdictionId: "stable-jurisdiction" });
    expect(chatBody).toMatchObject({ jurisdictionId: "stable-jurisdiction", country: "NG" });
    expect(mocks.appendMessages.mock.calls[0][0]).toMatchObject({
      jurisdictionId: "stable-jurisdiction",
      country: "GH",
    });
  });

  it("persists a governed answer with no citations without requesting an empty citation claim", async () => {
    mocks.unifiedEnabled = true;
    mocks.resolvedSelection = {
      id: "organization-jurisdiction",
      name: "Public Organization",
      slug: "public-organization",
      kind: "organizational",
      isDefault: false,
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: "governed context",
        correlationToken: "token",
        jurisdictionId: "organization-jurisdiction",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: "No supported citation was returned.",
        citations: [],
      }), { status: 200 })));

    render(<ChatWorkspace
      chatId="empty-citations-chat"
      initialQuery="What is the policy?"
      initialJurisdiction="organization-jurisdiction"
    />);

    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalled());
    const assistant = mocks.appendMessages.mock.calls[0][0].messages[1];
    expect(assistant).not.toHaveProperty("citations");
    expect(assistant).not.toHaveProperty("citationClaim");
  });

  it.each([
    { kind: "organizational" as const, country: null },
    { kind: "geographic" as const, country: "GH" },
  ])("keeps a stored $kind ID chat readable but explicitly read-only while the unified rollout is disabled", async ({ kind, country }) => {
    const chatId = `saved-${kind}`;
    mocks.unifiedEnabled = false;
    mocks.session = {
      country,
      title: "Saved governed chat",
      jurisdictionId: `${kind}-jurisdiction`,
      jurisdictionName: kind === "organizational" ? "Public Organization" : "Ghana",
      jurisdictionKind: kind,
      jurisdictionContract: "unified",
    };
    mocks.sessions = [{
      id: chatId,
      title: "Saved governed chat",
      lastMessage: "Previously saved answer",
      timestamp: Date.now(),
      messageCount: 1,
    }];
    mocks.messages = [{
      storageId: "stored-message",
      clientId: "stored-client",
      role: "assistant",
      content: "Previously saved answer",
      createdAt: 1,
      creationTime: 1,
    }];

    render(<ChatWorkspace chatId={chatId} initialQuery="Do not submit" />);

    expect(await screen.findByText("Previously saved answer")).toBeVisible();
    expect(screen.getAllByText("Saved governed chat").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Research for this saved jurisdiction is temporarily unavailable while unified jurisdictions are disabled.",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.appendMessages).not.toHaveBeenCalled();
  });

  it("keeps an explicit legacy ID session writable while the unified rollout is disabled", async () => {
    mocks.unifiedEnabled = false;
    mocks.session = {
      country: "GH",
      title: "Legacy dual-write chat",
      jurisdictionId: "ghana-jurisdiction",
      jurisdictionName: "Ghana",
      jurisdictionKind: "geographic",
      jurisdictionContract: "legacy",
    };

    render(<ChatWorkspace chatId="legacy-chat" initialQuery="What changed?" />);

    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalled());
    expect(screen.getByRole("textbox")).not.toBeDisabled();
    expect(screen.queryByText(
      "Research for this saved jurisdiction is temporarily unavailable while unified jurisdictions are disabled.",
    )).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalled();
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
