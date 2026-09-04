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
  resolvedSelection: null as null | {
    id: string;
    name: string;
    slug: string;
    kind: "geographic" | "organizational";
    isDefault: boolean;
  },
  session: null as null | {
    title: string;
    jurisdictionId?: string | null;
    jurisdictionName?: string | null;
    jurisdictionKind?: "geographic" | "organizational" | null;
  },
  sessions: [] as Array<{
    id: string;
    title: string;
    lastMessage: string;
    timestamp: number;
    messageCount: number;
  }>,
  messages: [] as Array<{
    storageId: string;
    clientId: string | null;
    role: "user" | "assistant";
    content: string;
    createdAt: number;
    creationTime: number;
  }>,
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

const chatId = "7bb69b0e-cc01-4b98-ac37-6c8ca7e44c4c";
const jurisdiction = {
  id: "organization-jurisdiction",
  name: "Private University",
  slug: "private-university",
  kind: "organizational" as const,
  isDefault: false,
};
const citation = {
  label: "University policy, page 3",
  jurisdictionId: jurisdiction.id,
  jurisdictionName: jurisdiction.name,
  jurisdictionKind: jurisdiction.kind,
  relation: "selected" as const,
};
const citationClaim = "c".repeat(43);

function ndjsonResponse(events: unknown[]): Response {
  return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
    headers: { "content-type": "application/x-ndjson" },
  });
}

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
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.resolvedSelection = jurisdiction;
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
    if (name === "jurisdictions:resolveResearchSelection") {
      return args === "skip" ? undefined : mocks.resolvedSelection;
    }
    if (name === "chats:getByExternalId") return args === "skip" ? undefined : mocks.session;
    return undefined;
  });
  mocks.useMutation.mockImplementation((reference) => {
    const name = getFunctionName(reference);
    if (name === "chats:ensure") return mocks.ensureSession;
    if (name === "chats:appendMessages") return mocks.appendMessages;
    return vi.fn();
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
    { type: "done", result: "Answer", citations: [citation], citationClaim, partialCoverage: false },
  ])));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("unified chat client", () => {
  it("normalizes escaped paragraph breaks before rendering persisted assistant Markdown", async () => {
    mocks.session = {
      title: "Formatted answer",
      jurisdictionId: jurisdiction.id,
      jurisdictionName: jurisdiction.name,
      jurisdictionKind: jurisdiction.kind,
    };
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

  it("posts once to chat with the stable jurisdiction and persists only after done", async () => {
    let resolveEnsure!: () => void;
    mocks.ensureSession.mockReturnValue(new Promise<void>((resolve) => { resolveEnsure = resolve; }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "delta", text: "Governed " },
      { type: "done", result: "Governed answer", citations: [citation], citationClaim, partialCoverage: true },
    ])));

    render(
      <ChatWorkspace
        chatId={chatId}
        initialQuery="What is the policy?"
        initialJurisdiction={jurisdiction.id}
      />,
    );

    await waitFor(() => expect(mocks.ensureSession).toHaveBeenCalledWith({
      externalId: chatId,
      jurisdictionId: jurisdiction.id,
      jurisdictionName: jurisdiction.name,
      jurisdictionKind: jurisdiction.kind,
    }));
    expect(fetch).not.toHaveBeenCalled();
    resolveEnsure();

    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("/api/chat");
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body).toEqual({
      query: "What is the policy?",
      jurisdictionId: jurisdiction.id,
      messages: [],
      externalId: chatId,
      assistantClientId: expect.any(String),
    });
    expect(mocks.appendMessages.mock.calls[0][0]).toMatchObject({
      externalId: chatId,
      jurisdictionId: jurisdiction.id,
      jurisdictionName: jurisdiction.name,
      jurisdictionKind: jurisdiction.kind,
      messages: [
        { role: "user", content: "What is the policy?" },
        { role: "assistant", content: "Governed answer", citationClaim },
      ],
    });
    expect(mocks.appendMessages.mock.calls[0][0]).not.toHaveProperty("country");
    expect(await screen.findByRole("region", { name: "Sources" })).toHaveTextContent(citation.label);
    expect(screen.getByRole("status")).toHaveTextContent("Partial coverage");
  });

  it("batches streamed deltas into one animation frame", async () => {
    let frame!: FrameRequestCallback;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let finishStream!: () => void;
    const encoder = new TextEncoder();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"delta","text":"The streamed "}\n'));
        controller.enqueue(encoder.encode('{"type":"delta","text":"answer."}\n'));
        finishStream = () => {
          controller.enqueue(encoder.encode(`{"type":"done","result":"The streamed answer.","citations":[${JSON.stringify(citation)}],"citationClaim":"${citationClaim}","partialCoverage":false}\n`));
          controller.close();
        };
      },
    }), { headers: { "content-type": "application/x-ndjson" } })));

    render(
      <ChatWorkspace
        chatId="batched-stream"
        initialQuery="What is the rule?"
        initialJurisdiction={jurisdiction.id}
      />,
    );

    await waitFor(() => expect(requestAnimationFrame).toHaveBeenCalledTimes(1));
    expect(mocks.appendMessages).not.toHaveBeenCalled();

    await act(async () => frame(performance.now()));
    expect(await screen.findByText("The streamed answer.")).toBeVisible();

    finishStream();
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalledTimes(1));
  });

  it("marks both optimistic bubbles failed and does not persist an error event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "error", error: "We could not finish that answer." },
    ])));

    render(
      <ChatWorkspace
        chatId="failed-chat"
        initialQuery="What is the rule?"
        initialJurisdiction={jurisdiction.id}
      />,
    );

    expect(await screen.findByText("We could not finish that answer.")).toBeVisible();
    expect(screen.getAllByText("Failed")).toHaveLength(2);
    expect(mocks.appendMessages).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("persists the fixed no-evidence answer with its claim instead of showing Failed", async () => {
    const answer = "I couldn't find enough supporting material in this jurisdiction's library to answer. Try asking a more specific legal question.";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "done", result: answer, citations: [], citationClaim, partialCoverage: false },
    ])));
    render(<ChatWorkspace chatId="no-evidence-chat" initialQuery="hello" initialJurisdiction={jurisdiction.id} />);
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({ content: answer, citations: [], citationClaim })]),
    })));
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });

  it("handles the deployment's nested 504 error without rendering an object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      error: { code: "504", message: "An error occurred with your deployment" },
    }, { status: 504 })));
    render(<ChatWorkspace chatId="timeout-chat" initialQuery="hello" initialJurisdiction={jurisdiction.id} />);
    expect(await screen.findByText("The answer took too long to finish. Please try again.")).toBeVisible();
    expect(mocks.appendMessages).not.toHaveBeenCalled();
  });

  it("rejects done without citations and a one-use claim", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "done", result: "No supported citation was returned.", citations: [], partialCoverage: false },
    ])));

    render(
      <ChatWorkspace
        chatId="empty-citations-chat"
        initialQuery="What is the policy?"
        initialJurisdiction={jurisdiction.id}
      />,
    );

    expect(await screen.findByText("The answer could not be verified. Please try again.")).toBeVisible();
    expect(screen.getAllByText("Failed")).toHaveLength(2);
    expect(mocks.appendMessages).not.toHaveBeenCalled();
  });

  it("rejects cited done data without a valid citation claim", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "done", result: "Unverified answer", citations: [citation], citationClaim: "bad", partialCoverage: false },
    ])));

    render(
      <ChatWorkspace
        chatId="invalid-terminal-chat"
        initialQuery="What is the policy?"
        initialJurisdiction={jurisdiction.id}
      />,
    );

    expect(await screen.findByText("The answer could not be verified. Please try again.")).toBeVisible();
    expect(mocks.appendMessages).not.toHaveBeenCalled();
  });

  it("uses one unavailable state and performs no work for an unresolved route selection", async () => {
    mocks.resolvedSelection = null;

    render(
      <ChatWorkspace
        chatId={chatId}
        initialQuery="What is the policy?"
        initialJurisdiction="missing-jurisdiction"
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That jurisdiction is not available for research.",
    );
    expect(mocks.ensureSession).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not let a route parameter make a stored legacy chat writable", async () => {
    mocks.session = { title: "Historical chat" };

    render(
      <ChatWorkspace
        chatId="historical-chat"
        initialQuery="Do not submit"
        initialJurisdiction={jurisdiction.id}
      />,
    );

    expect(screen.getByRole("textbox")).toBeDisabled();
    await act(async () => undefined);
    expect(mocks.ensureSession).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
