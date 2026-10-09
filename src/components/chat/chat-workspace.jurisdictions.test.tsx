import { act, cleanup, fireEvent, render as renderComponent, screen, waitFor, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { saveGuestResearchDraft } from "@/lib/guest-research-draft";
import type { PersistedChatMessage } from "./chat-message-state";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  chatId: "7bb69b0e-cc01-4b98-ac37-6c8ca7e44c4c" as string | undefined,
  search: new URLSearchParams(),
  replace: vi.fn(),
  useQuery: vi.fn(),
  usePaginatedQuery: vi.fn(),
  useMutation: vi.fn(),
  ensureSession: vi.fn(),
  appendMessages: vi.fn(),
  removeSession: vi.fn(),
  identityId: "user-1" as string | null,
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
  messages: [] as PersistedChatMessage[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  useParams: () => ({ chatId: mocks.chatId }),
  useSearchParams: () => mocks.search,
  notFound: () => { throw new Error("Not found"); },
}));

vi.mock("@/components/providers/account-providers", () => ({
  AccountProviders: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span aria-label={alt} />,
}));

vi.mock("next/font/local", () => ({
  default: () => ({ variable: "chat-font" }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: mocks.identityId ? { user: { id: mocks.identityId } } : null,
      isPending: false,
      error: null,
    }),
  },
}));

// Saved job observation has its own integration suite in chat-background.test.tsx.
vi.mock("./use-chat-background-job", () => ({ findAcceptedChatBackgroundJob: async () => null, useChatBackgroundJob: () => ({
  job: null, enabled: false, awaitedAssistantClientId: null, checking: false, uncertain: false, isPending: false, cancelling: false,
  cancelError: null, recoveryOutcome: null, cancel: vi.fn(),
}) }));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useMutation: (reference: unknown) => mocks.useMutation(reference),
  usePaginatedQuery: mocks.usePaginatedQuery,
  useQuery: mocks.useQuery,
}));

vi.mock("@/components/jurisdictions/research-jurisdiction-picker", () => ({
  ResearchJurisdictionPicker: ({ onChange }: { onChange: (value: typeof mocks.resolvedSelection) => void }) => (
    <button onClick={() => onChange(mocks.resolvedSelection)}>Select test jurisdiction</button>
  ),
}));

import { ChatWorkspace } from "./chat-workspace";
import ChatLayout from "@/app/(chat)/layout";
import ChatPage from "@/app/(chat)/[chatId]/page";
import NewChatPage from "@/app/(chat)/new/page";
import { ChatRequestIdentity, ChatRequestsProvider } from "./chat-requests";
import { CHAT_POLICY_RESPONSES } from "../../../convex/lib/chatPolicy";

const render = (ui: React.ReactNode) => renderComponent(ui, {
  wrapper: ({ children }) => <ChatRequestsProvider><ChatRequestIdentity />{children}</ChatRequestsProvider>,
});

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
  return new Response(`${events.map((event) => JSON.stringify(
    (event as { type?: string }).type === "done" ? { answerKind: "legal", ...(event as object) } : event,
  )).join("\n")}\n`, {
    headers: { "content-type": "application/x-ndjson" },
  });
}

describe("server-persisted reviewed responses", () => {
  it("keeps a background acknowledgement pending without displaying or saving an answer", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ type: "background_job", jobId: "job-1", status: "queued" }, { status: 202 }));
    mocks.session = { title: "Saved", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Do I need written notice?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/chat", expect.anything()));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
    expect(screen.getByRole("status", { name: "Preparing answer" })).toBeVisible();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(mocks.appendMessages).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/chat")).toHaveLength(1);
  });

  it.each([12, 22])("sends up to twenty turns and explicitly marks completeness for a %i-turn history", async count => {
    mocks.session = { title: "History", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    mocks.messages = Array.from({ length: count }, (_, index) => ({ storageId: `history-${index}`, clientId: `client-${index}`,
      role: index % 2 ? "assistant" : "user", content: `Context ${index}`, createdAt: index, creationTime: index }));
    render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "How much notice?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/chat", expect.anything()));
    const sent = JSON.parse(vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/chat")![1]!.body as string);
    expect(sent.messages).toHaveLength(Math.min(20, count)); expect(sent.historyComplete).toBe(count <= 20);
    if (count <= 20) expect(sent.messages[0].content).toBe("Context 0");
  });
  it("marks a partly loaded persisted history incomplete even when the visible turns fit", async () => {
    mocks.session = { title: "History", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    const original = mocks.usePaginatedQuery.getMockImplementation()!;
    mocks.usePaginatedQuery.mockImplementation((reference, ...args) => getFunctionName(reference) === "chats:listMessages"
      ? { results: [], status: "CanLoadMore", loadMore: vi.fn() } : original(reference, ...args));
    render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "How much notice?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/chat", expect.anything()));
    const sent = JSON.parse(vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/chat")![1]!.body as string);
    expect(sent.historyComplete).toBe(false);
  });
  it("sends the optimistic user ID and skips duplicate persistence while clearing the draft", async () => {
    vi.mocked(fetch).mockResolvedValue(ndjsonResponse([{ type: "done", result: "Saved reviewed answer", citations: [citation],
      citationClaim, partialCoverage: false, persisted: true }]));
    mocks.session = { title: "Saved", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "How much notice?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    expect(screen.getByText("Saved reviewed answer")).toBeVisible(); expect(mocks.appendMessages).not.toHaveBeenCalled();
    const sent = JSON.parse(vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/chat")![1]!.body as string);
    expect(sent.userClientId).toMatch(/^[a-f0-9-]{36}$/u); expect(sent.userClientId).not.toBe(sent.assistantClientId);
  });
  it("reloads a server-persisted reviewed legal answer and its page citation without another request or append", async () => {
    const question = "Do I need written notice?";
    const answer = "The supplied reviewed edition requires written notice in this scenario.";
    const reviewedCitation = { ...citation, label: "Reviewed Employment Act, page 11" };
    vi.mocked(fetch).mockResolvedValue(ndjsonResponse([{ type: "done", result: answer, answerKind: "legal",
      citations: [reviewedCitation], citationClaim, partialCoverage: false, persisted: true }]));
    mocks.session = { title: "Written notice", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    const view = render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: question } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    expect(screen.getByText(answer)).toBeVisible();
    expect(mocks.appendMessages).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    view.unmount();
    // This is the public listMessages shape; the consumed citation claim is not reloaded.
    mocks.messages = [
      { storageId: "saved-reviewed-user", clientId: sent.userClientId, role: "user", content: question,
        createdAt: 1, creationTime: 1 },
      { storageId: "saved-reviewed-assistant", clientId: sent.assistantClientId, role: "assistant", content: answer,
        createdAt: 2, creationTime: 2, completedAt: 2, durationMs: 1000, answerKind: "legal", citations: [reviewedCitation],
        originalSourceUrls: [`/api/chat/sources/saved-reviewed-assistant/0?chat=${chatId}#page=11`] },
    ];
    vi.mocked(fetch).mockClear();
    render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    expect(screen.getAllByText(question)).toHaveLength(1);
    expect(screen.getAllByText(answer)).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Sources" })).toHaveTextContent(reviewedCitation.label);
    expect(screen.getByRole("link", { name: `${reviewedCitation.label} (opens in a new tab)` }))
      .toHaveAttribute("href", `/api/chat/sources/saved-reviewed-assistant/0?chat=${chatId}#page=11`);
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.appendMessages).not.toHaveBeenCalled();
  });
  it.each(["true", 1, null])("rejects malformed persisted marker %s without consuming a claim", async persisted => {
    vi.mocked(fetch).mockResolvedValue(ndjsonResponse([{ type: "done", result: "Malformed response", citations: [citation], citationClaim, partialCoverage: false, persisted }]));
    mocks.session = { title: "Saved", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "How much notice?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send question" })).toBeEnabled());
    expect(mocks.appendMessages).not.toHaveBeenCalled(); expect(screen.getByRole("textbox")).toHaveValue("How much notice?");
  });
});

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  mocks.push.mockReset();
  mocks.chatId = chatId;
  mocks.search = new URLSearchParams();
  mocks.replace.mockReset();
  mocks.useQuery.mockReset();
  mocks.usePaginatedQuery.mockReset();
  mocks.useMutation.mockReset();
  mocks.ensureSession.mockReset();
  mocks.appendMessages.mockReset();
  mocks.removeSession.mockReset();
  mocks.removeSession.mockResolvedValue(undefined);
  mocks.identityId = "user-1";
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
    if (name === "chats:remove") return mocks.removeSession;
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
  function mockAttachmentUpload({ failFirst = false, answerFails = false } = {}) {
    let uploadedCount = 0;
    let preparedCount = 0;
    class Upload {
      upload = { onprogress: null as null | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) };
      headers = new Map<string, string>();
      status = 200;
      responseText = "";
      onload?: () => void;
      onerror?: () => void;
      onabort?: () => void;
      open() {}
      setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
      abort() { this.onabort?.(); }
      send(file: File) {
        uploadedCount += 1;
        queueMicrotask(() => {
          if (failFirst && uploadedCount === 1) { this.onerror?.(); return; }
          this.responseText = JSON.stringify({ attachment: { id: this.headers.get("x-attachment-id"), filename: file.name, mimeType: file.type, byteSize: file.size, kind: "text" } });
          this.onload?.();
        });
      }
    }
    vi.stubGlobal("XMLHttpRequest", Upload);
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      if (url === "/api/chat/attachments") {
        preparedCount += 1;
        return Promise.resolve(Response.json({ attachmentId: `attachment-${preparedCount}`, uploadUrl: "https://upload.test", token: "token" }));
      }
      return Promise.resolve(answerFails
        ? Response.json({ error: "Answer temporarily unavailable" }, { status: 500 })
        : ndjsonResponse([{ type: "done", result: "Your document says the code is ORCHARD-72.", answerKind: "document", citations: [], citationClaim, partialCoverage: false }]));
    }));
  }

  it("sends files-only questions, saves attachment references, and restores private file links after reload", async () => {
    mockAttachmentUpload();
    mocks.session = { title: "Documents", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    const view = render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    fireEvent.change(screen.getByLabelText("Choose files to attach"), { target: { files: [new File(["ORCHARD-72"], "notes.txt", { type: "text/plain" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith("/api/chat", expect.objectContaining({ body: expect.stringContaining('"attachmentIds":["attachment-1"]') }));
    const saved = mocks.appendMessages.mock.calls[0][0].messages;
    expect(saved[0]).toMatchObject({ content: "Summarize these files.", attachmentIds: ["attachment-1"] });
    expect(screen.getByText("Based on your files")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Remove notes.txt" })).not.toBeInTheDocument();
    mocks.messages = saved.map((message: PersistedChatMessage, index: number) => ({
      ...message, storageId: `persisted-${index}`, creationTime: message.createdAt,
      ...(index === 0 ? { attachments: [{ id: "attachment-1", filename: "notes.txt", mimeType: "text/plain", byteSize: 10, kind: "text" as const }] } : {}),
    }));
    view.unmount();
    render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    expect(screen.getByRole("link", { name: "Download notes.txt" })).toHaveAttribute("href", "/api/chat/attachments/attachment-1?download=1");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "What was the code again?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalledTimes(2));
    const chatCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => url === "/api/chat");
    expect(JSON.parse(chatCalls[1][1].body)).toMatchObject({ query: "What was the code again?", attachmentIds: [] });
  });

  it.each(["button", "Enter"] as const)("submits a retained ready draft with a blank question using %s while production uploads are disabled", async trigger => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("NEXT_PUBLIC_CHAT_ATTACHMENTS_ENABLED", "1");
    try {
      mockAttachmentUpload({ answerFails: true });
      mocks.session = { title: "Documents", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
      const workspace = render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
      fireEvent.change(screen.getByLabelText("Choose files to attach"), { target: { files: [new File(["ORCHARD-72"], "retained.txt", { type: "text/plain" })] } });
      fireEvent.click(screen.getByRole("button", { name: "Send question" }));
      await waitFor(() => expect(screen.getByText(/Uploaded/)).toBeVisible());
      await waitFor(() => expect(screen.getByRole("button", { name: "Send question" })).toBeEnabled());
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/chat")).toHaveLength(1);

      const attachmentFetch = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation((url, init) => url === "/api/chat"
        ? Promise.resolve(ndjsonResponse([{ type: "done", result: "Retained upload answer", answerKind: "document", citations: [], citationClaim, partialCoverage: false }]))
        : attachmentFetch(url, init));
      vi.stubEnv("NEXT_PUBLIC_CHAT_ATTACHMENTS_ENABLED", undefined);
      workspace.rerender(<ChatWorkspace chatId={chatId} initialQuery={null} />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
      expect(screen.getByRole("textbox")).toHaveValue("");
      expect(screen.queryByRole("button", { name: "Attach files" })).not.toBeInTheDocument();
      expect(document.querySelector('input[type="file"]')).toBeNull();
      expect(within(screen.getByRole("region", { name: "Attached files" })).getByTitle("retained.txt")).toBeVisible();
      expect(screen.getByRole("link", { name: "Download retained.txt" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Send question" })).toBeEnabled();

      if (trigger === "button") fireEvent.click(screen.getByRole("button", { name: "Send question" }));
      else fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", code: "Enter" });
      await waitFor(() => expect(screen.getByText("Retained upload answer")).toBeVisible());
      const chatCalls = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/chat");
      expect(chatCalls).toHaveLength(2);
      expect(JSON.parse(chatCalls[1][1]!.body as string)).toMatchObject({
        query: "Summarize these files.", attachmentIds: ["attachment-1"],
      });
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/chat/attachments")).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("retains files and text after upload and answer failures and exposes an upload retry", async () => {
    mockAttachmentUpload({ failFirst: true, answerFails: true });
    mocks.session = { title: "Documents", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Please read my file" } });
    fireEvent.change(screen.getByLabelText("Choose files to attach"), { target: { files: [new File(["ORCHARD-72"], "notes.txt", { type: "text/plain" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    expect(await screen.findByRole("button", { name: "Retry notes.txt" })).toBeEnabled();
    expect(screen.getByRole("textbox")).toHaveValue("Please read my file");
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => url === "/api/chat")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry notes.txt" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send question" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    expect(await screen.findByText("Answer temporarily unavailable")).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("Please read my file");
    expect(screen.getByRole("button", { name: "Remove notes.txt" })).toBeEnabled();
    expect(mocks.appendMessages).not.toHaveBeenCalled();
  });

  it("retains an upload failure and a background retry after leaving and remounting the workspace", async () => {
    mockAttachmentUpload();
    let finishPrepare!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>((resolve) => { finishPrepare = resolve; }));
    mocks.session = { title: "Documents", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    const workspace = <ChatWorkspace chatId={chatId} initialQuery={null} />;
    const view = render(workspace);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Please read my file" } });
    fireEvent.change(screen.getByLabelText("Choose files to attach"), { target: { files: [new File(["ORCHARD-72"], "notes.txt", { type: "text/plain" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/chat/attachments", expect.anything()));
    view.rerender(<div>Settings</div>);
    await act(async () => finishPrepare(Response.json({ error: "Upload preparation failed" }, { status: 503 })));
    view.rerender(workspace);
    expect(screen.getByRole("textbox")).toHaveValue("Please read my file");
    expect(screen.getByText("Upload preparation failed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry notes.txt" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();

    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>((resolve) => { finishPrepare = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Retry notes.txt" }));
    view.rerender(<div>Settings</div>);
    await act(async () => finishPrepare(Response.json({ attachmentId: "background-file", uploadUrl: "https://upload.test", token: "token" })));
    view.rerender(workspace);
    expect(screen.getByRole("textbox")).toHaveValue("Please read my file");
    expect(screen.getByText(/Uploaded/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Send question" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalledTimes(1));
    expect(mocks.appendMessages.mock.calls[0][0].messages[0]).toMatchObject({ attachmentIds: ["background-file"] });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/chat/attachments")).toHaveLength(2);
    view.rerender(<div>Settings</div>);
    view.rerender(workspace);
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Remove notes.txt" })).not.toBeInTheDocument();
  });

  it.each([
    ["deadline_exceeded", /took too long/i],
    ["file_search_budget_exhausted", /search limit/i],
  ] as const)("retains uploaded files after %s and reuses them for a clean document retry", async (reason, message) => {
    mockAttachmentUpload();
    const attachmentFetch = vi.mocked(fetch).getMockImplementation()!;
    const cancel = vi.fn();
    let attempts = 0;
    vi.mocked(fetch).mockImplementation((url, init) => {
      if (url !== "/api/chat" || attempts++ > 0) return attachmentFetch(url, init);
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", reason, error: "Generic fallback" })}\n`));
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "done", answerKind: "document", result: "Late file answer", citations: [], citationClaim, partialCoverage: false })}\n`));
        },
        cancel,
      }), { headers: { "content-type": "application/x-ndjson" } }));
    });
    mocks.session = { title: "Documents", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Read this document" } });
    fireEvent.change(screen.getByLabelText("Choose files to attach"), { target: { files: [new File(["ORCHARD-72"], "notes.txt", { type: "text/plain" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("textbox")).toHaveValue("Read this document");
    expect(screen.getByRole("button", { name: "Remove notes.txt" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send question" })).toBeEnabled();
    expect(screen.queryByText("Late file answer")).not.toBeInTheDocument();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mocks.appendMessages).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalledTimes(1));
    const chatCalls = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/chat");
    expect(JSON.parse(chatCalls[1][1]!.body as string)).toMatchObject({ attachmentIds: ["attachment-1"], messages: [] });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/chat/attachments")).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove notes.txt" })).not.toBeInTheDocument();
    expect(screen.getByText("Based on your files")).toBeVisible();
  });

  it("keeps the allocated new-chat attachment draft through navigation and background completion", async () => {
    mockAttachmentUpload();
    let finishEnsure!: () => void;
    mocks.ensureSession.mockReturnValue(new Promise<void>((resolve) => { finishEnsure = resolve; }));
    const view = render(<ChatWorkspace chatId={null} initialQuery={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Select test jurisdiction" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Read A" } });
    fireEvent.change(screen.getByLabelText("Choose files to attach"), { target: { files: [new File(["A"], "a.txt", { type: "text/plain" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    const externalId = mocks.ensureSession.mock.calls[0][0].externalId;
    view.rerender(<ChatWorkspace chatId={externalId} initialQuery={null} initialJurisdiction={jurisdiction.id} />);
    expect(screen.getByRole("textbox")).toHaveValue("Read A");
    expect(screen.getByRole("button", { name: "Remove a.txt" })).toBeDisabled();
    view.rerender(<ChatWorkspace chatId="chat-b" initialQuery={null} initialJurisdiction={jurisdiction.id} />);
    expect(screen.queryByRole("button", { name: "Remove a.txt" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Draft B" } });
    fireEvent.change(screen.getByLabelText("Choose files to attach"), { target: { files: [new File(["B"], "b.txt", { type: "text/plain" })] } });
    await act(async () => finishEnsure());
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalledWith(expect.objectContaining({ externalId })));
    expect(screen.getByRole("textbox")).toHaveValue("Draft B");
    expect(screen.getByRole("button", { name: "Remove b.txt" })).toBeEnabled();
    view.rerender(<ChatWorkspace chatId={externalId} initialQuery={null} initialJurisdiction={jurisdiction.id} />);
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Remove a.txt" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download a.txt" })).toBeVisible();
  });

  it("keeps verified source links when a guest answer is saved to the account", () => {
    mocks.session = { title: "Claimed research", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    mocks.messages = [{
      storageId: "saved-answer", clientId: "guest-answer", role: "assistant", content: "Verified answer", createdAt: 1, creationTime: 1,
      citations: [citation], guestSources: [{ ...citation, jurisdictionId: citation.jurisdictionId as import("@/convex/_generated/dataModel").Id<"jurisdictions">,
        issuer: "Authority", officialCitation: "Act 1", effectiveDate: null, sourceUrl: "https://example.org/act.pdf" }],
    }];
    render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    expect(screen.getByRole("link", { name: `${citation.label} (opens in a new tab)` })).toHaveAttribute("href", "https://example.org/act.pdf");
  });

  it("restores a failed guest question into a fresh chat once its jurisdiction is ready, without sending", () => {
    saveGuestResearchDraft("Retry my guest question", chatId);
    mocks.resolvedSelection = null;
    const workspace = <ChatWorkspace chatId={chatId} initialQuery={null} initialJurisdiction={jurisdiction.id} />;
    const view = render(workspace);
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(localStorage.getItem(`guest-research-draft:${chatId}`)).not.toBeNull();

    mocks.resolvedSelection = jurisdiction;
    view.rerender(<ChatWorkspace chatId={chatId} initialQuery={null} initialJurisdiction={jurisdiction.id} />);
    expect(screen.getByRole("textbox")).toHaveValue("Retry my guest question");
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(localStorage.getItem(`guest-research-draft:${chatId}`)).toBeNull();
    expect(mocks.ensureSession).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("restores the claimed guest question as an editable draft without sending it", async () => {
    saveGuestResearchDraft("What about my follow-up?", chatId);
    mocks.session = { title: "Claimed research", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    render(<StrictMode><ChatWorkspace chatId={chatId} initialQuery={null} /></StrictMode>);

    expect(screen.getByRole("textbox")).toHaveValue("What about my follow-up?");
    expect(localStorage.getItem(`guest-research-draft:${chatId}`)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edited follow-up" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string).query).toBe("Edited follow-up");
  });

  it("preserves the sidebar while a different chat route loads", () => {
    mocks.session = { title: "First chat" };
    mocks.sessions = [{ id: chatId, title: "Saved chat", lastMessage: "", timestamp: 1, messageCount: 0 }];
    const route = () => <ChatLayout>{mocks.chatId ? <ChatPage key={mocks.chatId} /> : <NewChatPage />}</ChatLayout>;
    const view = render(route());
    const sidebar = screen.getByLabelText("Chat history");
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    mocks.chatId = "6bb69b0e-cc01-4b98-ac37-6c8ca7e44c4c";
    mocks.useQuery.mockReturnValue(undefined);
    view.rerender(route());

    expect(screen.getByLabelText("Chat history")).toBe(sidebar);
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Saved chat/ })).toBeInTheDocument();
    expect(screen.queryByText("Loading chats…")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading chat…" })).toBeInTheDocument();

    mocks.chatId = undefined;
    view.rerender(route());
    expect(screen.getByLabelText("Chat history")).toBe(sidebar);
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "The law, in plain language." })).toBeInTheDocument();
  });

  it("starts a new chat before navigation finishes and waits only for session creation", async () => {
    let finishEnsure!: () => void;
    mocks.ensureSession.mockReturnValue(new Promise<void>((resolve) => { finishEnsure = resolve; }));
    render(<ChatWorkspace chatId={null} initialQuery={null} />);
    expect(screen.getByRole("textbox")).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hello" } });
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(mocks.ensureSession).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Select test jurisdiction" }));
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));

    await waitFor(() => expect(mocks.ensureSession).toHaveBeenCalledTimes(1));
    expect(mocks.push).toHaveBeenCalledWith(expect.stringMatching(/^\/[a-f0-9-]{36}\?jurisdiction=/u));
    expect(fetch).not.toHaveBeenCalled();
    const externalId = mocks.ensureSession.mock.calls[0][0].externalId;
    expect(mocks.push).toHaveBeenCalledWith(`/${externalId}?jurisdiction=${jurisdiction.id}`);

    await act(async () => finishEnsure());
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalledWith(expect.objectContaining({ externalId })));
    expect(JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)).toMatchObject({
      query: "Hello", jurisdictionId: jurisdiction.id, externalId,
    });
  });

  it("prefills a topic question without sending or choosing a jurisdiction", () => {
    render(<ChatWorkspace chatId={null} initialQuery={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Work & employment" }));
    expect(screen.getByRole("textbox")).toHaveValue("What should I know about my rights at work?");
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
    expect(mocks.ensureSession).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allocates only one new conversation for synchronous repeated sends", async () => {
    mocks.ensureSession.mockReturnValue(new Promise<void>(() => {}));
    render(<ChatWorkspace chatId={null} initialQuery={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Select test jurisdiction" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Read my files" } });
    const send = screen.getByRole("button", { name: "Send question" });
    act(() => {
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.ensureSession).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it("shows a recoverable error when creating a new chat fails", async () => {
    mocks.ensureSession.mockRejectedValue(new Error("create failed"));
    const view = render(<ChatWorkspace chatId={null} initialQuery={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Select test jurisdiction" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledTimes(1));
    const externalId = mocks.ensureSession.mock.calls[0][0].externalId;
    view.rerender(<ChatWorkspace key={externalId} chatId={externalId} initialQuery={null} initialJurisdiction={jurisdiction.id} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("We could not start this chat");
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the chat list visible while a newly created chat loads", () => {
    mocks.usePaginatedQuery.mockImplementation((reference) => ({
      results: [],
      status: getFunctionName(reference) === "chats:list" ? "LoadingFirstPage" : "Exhausted",
      loadMore: vi.fn(),
    }));
    mocks.useQuery.mockImplementation((reference) =>
      getFunctionName(reference) === "chats:getByExternalId" ? undefined : null,
    );
    const { container } = render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    expect(screen.getByLabelText("Chat history")).toBeInTheDocument();
    expect(screen.getByText("Loading chats…")).toBeInTheDocument();
    const loading = screen.getByRole("status", { name: "Loading chat…" });
    expect(loading).toBeInTheDocument();
    expect(screen.getByLabelText("Chat history")).not.toContainElement(loading);
    expect(container.firstElementChild).toContainElement(loading);
  });

  it("keeps both conversations streaming across switches and remounts, saving each to its own chat", async () => {
    const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const signals = new Map<string, AbortSignal>();
    const encoder = new TextEncoder();
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => {
      const { externalId } = JSON.parse(init.body as string);
      signals.set(externalId, init.signal!);
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) { streams.set(externalId, controller); },
      }), { headers: { "content-type": "application/x-ndjson" } }));
    }));
    const send = (id: string, event: unknown) => streams.get(id)!.enqueue(
      encoder.encode(`${JSON.stringify((event as { type?: string }).type === "done"
        ? { answerKind: "legal", ...(event as object) } : event)}\n`),
    );
    const page = (id: string, question: string | null, key = "page") => (
      <ChatWorkspace key={key} chatId={id} initialQuery={question} initialJurisdiction={jurisdiction.id} />
    );
    const view = render(page("chat-a", "Question A"));
    await waitFor(() => expect(streams.has("chat-a")).toBe(true));
    view.rerender(page("chat-b", "Question B"));
    expect(signals.get("chat-a")!.aborted).toBe(false);
    await waitFor(() => expect(streams.has("chat-b")).toBe(true));

    await act(async () => {
      send("chat-a", { type: "delta", text: "Answer A so far" });
      send("chat-b", { type: "delta", text: "Answer B so far" });
    });
    expect(await screen.findByText("Answer B so far")).toBeVisible();
    expect(screen.queryByText("Answer A so far")).not.toBeInTheDocument();
    view.rerender(page("chat-a", null, "remounted-page"));
    expect(await screen.findByText("Answer A so far")).toBeVisible();
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(signals.get("chat-b")!.aborted).toBe(false);

    await act(async () => {
      for (const id of ["chat-b", "chat-a"]) {
        send(id, { type: "done", result: `Finished ${id}`, citations: [citation], citationClaim, partialCoverage: false });
        streams.get(id)!.close();
      }
    });
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalledTimes(2));
    for (const id of ["chat-a", "chat-b"]) {
      expect(mocks.appendMessages).toHaveBeenCalledWith(expect.objectContaining({
        externalId: id,
        lastMessage: `Finished ${id}`,
      }));
    }
    expect(await screen.findByText("Finished chat-a")).toBeVisible();
    expect(screen.queryByText("Finished chat-b")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("finishes creating and saving a background chat without clearing the visible draft", async () => {
    let finishEnsure!: () => void;
    mocks.ensureSession.mockReturnValue(new Promise<void>((resolve) => { finishEnsure = resolve; }));
    const view = render(<ChatWorkspace chatId="creating-chat" initialQuery="Question A" initialJurisdiction={jurisdiction.id} />);
    await waitFor(() => expect(mocks.ensureSession).toHaveBeenCalledTimes(1));
    view.rerender(<ChatWorkspace key="new-page" chatId="another-chat" initialQuery={null} initialJurisdiction={jurisdiction.id} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsent draft" } });
    await act(async () => finishEnsure());
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalledWith(expect.objectContaining({
      externalId: "creating-chat", lastMessage: "Answer",
    })));
    expect(screen.getByRole("textbox")).toHaveValue("Unsent draft");
    expect(screen.queryByText("Answer")).not.toBeInTheDocument();
  });

  it.each(["stream", "save"])("keeps a background %s failure with its conversation", async (failure) => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>((resolve) => { finish = resolve; })));
    if (failure === "save") mocks.appendMessages.mockRejectedValue(new Error("save failed"));
    const page = (id: string, question: string | null) => <ChatWorkspace key={id} chatId={id} initialQuery={question} initialJurisdiction={jurisdiction.id} />;
    const view = render(page("failed-background", "Question"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    view.rerender(page("visible-chat", null));
    await act(async () => finish(ndjsonResponse([
      failure === "stream"
        ? { type: "error", error: "Background answer failed" }
        : { type: "done", result: "Unsaved answer", citations: [citation], citationClaim, partialCoverage: false },
    ])));
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    view.rerender(page("failed-background", null));
    expect(await screen.findByText(failure === "stream" ? "Background answer failed" : "Unsaved answer")).toBeVisible();
    expect(screen.getAllByText("Failed")).toHaveLength(2);
    expect(screen.getByRole("textbox")).toBeEnabled();
    if (failure === "save") expect(screen.getByRole("alert")).toHaveTextContent("could not be saved");
  });

  it("cancels only the deleted background conversation and rejects its late result", async () => {
    const pending = new Map<string, { signal: AbortSignal; finish: (response: Response) => void }>();
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise<Response>((finish) => {
      pending.set(JSON.parse(init.body as string).externalId, { signal: init.signal!, finish });
    })));
    mocks.sessions = ["delete-me", "keep-me"].map((id) => ({ id, title: id, lastMessage: "", timestamp: 1, messageCount: 0 }));
    const page = (id: string) => <ChatWorkspace key={id} chatId={id} initialQuery={`Question ${id}`} initialJurisdiction={jurisdiction.id} />;
    const view = render(page("delete-me"));
    await waitFor(() => expect(pending.has("delete-me")).toBe(true));
    view.rerender(page("keep-me"));
    await waitFor(() => expect(pending.has("keep-me")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Delete chat: delete-me" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));
    await waitFor(() => expect(mocks.removeSession).toHaveBeenCalledWith({ externalId: "delete-me" }));
    expect(pending.get("delete-me")!.signal.aborted).toBe(true);
    expect(pending.get("keep-me")!.signal.aborted).toBe(false);
    await act(async () => {
      for (const [id, request] of pending) request.finish(ndjsonResponse([
        { type: "done", result: `Finished ${id}`, citations: [citation], citationClaim, partialCoverage: false },
      ]));
    });
    expect(await screen.findByText("Finished keep-me")).toBeVisible();
    expect(mocks.appendMessages).toHaveBeenCalledTimes(1);
    expect(mocks.appendMessages).toHaveBeenCalledWith(expect.objectContaining({ externalId: "keep-me" }));
  });

  it.each([null, "user-2"])("clears pending answers when the signed-in identity changes to %s", async (nextIdentity) => {
    let finish!: (response: Response) => void;
    let signal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => {
      signal = init.signal!;
      return new Promise<Response>((resolve) => { finish = resolve; });
    }));
    const page = <ChatWorkspace chatId="private-chat" initialQuery="Private question" initialJurisdiction={jurisdiction.id} />;
    const view = render(page);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    mocks.identityId = nextIdentity;
    view.rerender(<ChatWorkspace chatId="private-chat" initialQuery={null} initialJurisdiction={jurisdiction.id} />);
    expect(signal.aborted).toBe(true);
    await act(async () => finish(ndjsonResponse([
      { type: "done", result: "Private answer", citations: [citation], citationClaim, partialCoverage: false },
    ])));
    expect(screen.queryByText("Private answer")).not.toBeInTheDocument();
    expect(screen.queryByText("Private question")).not.toBeInTheDocument();
    expect(mocks.appendMessages).not.toHaveBeenCalled();
  });

  it("keeps deletion pending across navigation until session creation settles", async () => {
    let finishEnsure!: () => void;
    mocks.ensureSession.mockReturnValue(new Promise<void>((resolve) => { finishEnsure = resolve; }));
    mocks.sessions = [{ id: "creating-chat", title: "Creating chat", lastMessage: "", timestamp: 1, messageCount: 0 }];
    const page = (id: string, question: string | null) => <ChatWorkspace key={id} chatId={id} initialQuery={question} initialJurisdiction={jurisdiction.id} />;
    const view = render(page("creating-chat", "Question"));
    await waitFor(() => expect(mocks.ensureSession).toHaveBeenCalledTimes(1));
    view.rerender(page("another-chat", null));
    fireEvent.click(screen.getByRole("button", { name: "Delete chat: Creating chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));
    expect(mocks.removeSession).not.toHaveBeenCalled();
    view.rerender(page("creating-chat", null));
    expect(screen.getByText("Deleting chat…")).toBeVisible();
    await act(async () => finishEnsure());
    await waitFor(() => expect(mocks.removeSession).toHaveBeenCalledTimes(1));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText("Chat deleted…")).toBeVisible();
  });

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
      userClientId: expect.any(String),
      historyComplete: true,
      attachmentIds: [],
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
          controller.enqueue(encoder.encode(`{"type":"done","result":"The streamed answer.","answerKind":"legal","citations":[${JSON.stringify(citation)}],"citationClaim":"${citationClaim}","partialCoverage":false}\n`));
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

  it("explains the per-answer search limit immediately and accepts a narrower next question", async () => {
    let sendLimit!: () => void;
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) {
          sendLimit = () => {
            controller.enqueue(encoder.encode(`${JSON.stringify({
              type: "error", reason: "file_search_budget_exhausted", error: "Generic fallback",
            })}\n`));
            // Already buffered late data cannot replace a terminal failure.
            controller.enqueue(encoder.encode(`${JSON.stringify({
              type: "done", result: "Late answer that must stay hidden", answerKind: "legal",
              citations: [citation], citationClaim, partialCoverage: false,
            })}\n`));
          };
        },
        cancel,
      }), { headers: { "content-type": "application/x-ndjson" } }))
      .mockResolvedValueOnce(ndjsonResponse([
        { type: "done", result: "Verified narrower answer", citations: [citation], citationClaim, partialCoverage: false },
      ])));

    render(<ChatWorkspace chatId={chatId} initialQuery="What should I know about working here?" initialJurisdiction={jurisdiction.id} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("textbox")).toBeDisabled();
    await act(async () => sendLimit());

    expect(await screen.findByText(/Each answer has its own search limit/)).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Ask about one issue at a time");
    expect(screen.getByRole("alert")).toHaveTextContent("This limit applies only to that answer");
    expect(screen.getByRole("alert")).not.toHaveTextContent("You can send another question now");
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("textbox")).toHaveAccessibleDescription(/search limit/i);
    expect(screen.queryByRole("status", { name: "Preparing answer" })).not.toBeInTheDocument();
    expect(screen.queryByText("Generic fallback")).not.toBeInTheDocument();
    expect(screen.queryByText("Late answer that must stay hidden")).not.toBeInTheDocument();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mocks.appendMessages).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "How much paid time off can I take?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    expect(await screen.findByText("Verified narrower answer")).toBeVisible();
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalledTimes(1));
    const nextBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body as string);
    expect(nextBody.query).toBe("How much paid time off can I take?");
    expect(nextBody.messages).toEqual([]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(mocks.appendMessages.mock.calls[0][0].messages.map((message: { content: string }) => message.content))
      .toEqual(["How much paid time off can I take?", "Verified narrower answer"]);
  });

  it.each([
    ["file_search_budget_exhausted", /search limit/i],
    ["deadline_exceeded", /took too long/i],
  ] as const)("keeps %s scoped to its chat and leaves a new chat usable", async (reason, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "error", reason, error: "Generic fallback" },
    ])));
    const view = render(<ChatWorkspace chatId={chatId} initialQuery="What should I know?" initialJurisdiction={jurisdiction.id} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    view.rerender(<ChatWorkspace chatId={null} initialQuery={null} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Select test jurisdiction" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Can I take paid time off?" } });
    expect(screen.getByRole("button", { name: "Send question" })).toBeEnabled();
  });

  it.each([
    "provider_request_failed", "deadline_exceeded ", "DEADLINE_EXCEEDED",
    ["deadline_exceeded"], { reason: "deadline_exceeded" },
  ].map((reason) => ({ reason })))("does not interpret unknown or malformed reason %j as actionable", async ({ reason }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "error", reason, error: "We could not finish that answer." },
    ])));
    render(<ChatWorkspace chatId={chatId} initialQuery="What should I know?" initialJurisdiction={jurisdiction.id} />);
    expect(await screen.findByText("We could not finish that answer.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
  });

  it.each(["stream", "json"] as const)("explains a confirmed %s timeout and clears it for the next question", async (transport) => {
    const timeoutMessage = "This answer took too long and could not be verified. You can ask a more focused question or try again later.";
    const failure = { type: "error", reason: "deadline_exceeded", error: "Generic fallback" };
    const cancel = vi.fn();
    let finishNext!: (response: Response) => void;
    const first = transport === "json" ? Response.json(failure, { status: 500 }) : new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`${JSON.stringify(failure)}\n`));
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: "done", result: "Late unverified answer", answerKind: "legal",
          citations: [citation], citationClaim, partialCoverage: false,
        })}\n`));
      },
      cancel,
    }), { headers: { "content-type": "application/x-ndjson" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(first)
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishNext = resolve; })));
    render(<ChatWorkspace chatId={chatId} initialQuery="What rights do I have at work?" initialJurisdiction={jurisdiction.id} />);

    expect(await screen.findByText(timeoutMessage)).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/took too long/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/more focused question or try again later/i);
    expect(screen.getByRole("textbox")).toHaveAccessibleDescription(/took too long/i);
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.queryByRole("status", { name: "Preparing answer" })).not.toBeInTheDocument();
    expect(screen.queryByText("Generic fallback")).not.toBeInTheDocument();
    expect(screen.queryByText("Late unverified answer")).not.toBeInTheDocument();
    expect(mocks.appendMessages).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    if (transport === "stream") expect(cancel).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Can I take paid time off?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeDisabled();
    const nextBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body as string);
    expect(nextBody.messages).toEqual([]);
    await act(async () => finishNext(ndjsonResponse([
      { type: "done", result: "Verified answer after timeout", citations: [citation], citationClaim, partialCoverage: false },
    ])));
    expect(await screen.findByText("Verified answer after timeout")).toBeVisible();
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("textbox")).toBeEnabled();
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

  it("persists a policy refusal without showing Sources", async () => {
    const answer = CHAT_POLICY_RESPONSES.out_of_scope;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      { type: "done", result: answer, answerKind: "policy", citations: [], citationClaim, partialCoverage: false },
    ])));
    render(<ChatWorkspace chatId="policy-chat" initialQuery="Tell me a joke" initialJurisdiction={jurisdiction.id} />);
    await waitFor(() => expect(mocks.appendMessages).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({
        content: answer, answerKind: "policy", citations: [], citationClaim,
      })]),
    })));
    expect(await screen.findByText(answer)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Sources" })).not.toBeInTheDocument();
  });

  it("saves and reloads the coverage notice as policy without a Failed label or legal sources", async () => {
    const answer = "The reviewed material available here does not cover this question well enough to give a verified answer.";
    vi.mocked(fetch).mockResolvedValue(ndjsonResponse([
      { type: "done", result: answer, answerKind: "policy", citations: [], citationClaim, partialCoverage: false },
    ]));
    mocks.session = { title: "Tax question", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    const view = render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "What income tax applies to a small shop?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    expect(screen.getByText(answer)).toBeVisible();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sources" })).not.toBeInTheDocument();
    const saved = mocks.appendMessages.mock.calls[0][0].messages as PersistedChatMessage[];
    expect(saved[1]).toMatchObject({ content: answer, answerKind: "policy", citations: [], citationClaim });
    mocks.messages = saved.map((message, index) => ({ ...message, storageId: `saved-${index}`, creationTime: index }));
    view.unmount();
    vi.mocked(fetch).mockClear();
    render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    expect(screen.getByText(answer)).toBeVisible();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sources" })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
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


describe("production attachment upload controls", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each([undefined, "0"])("hides the file picker in production when the upload flag is %s", enabled => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("NEXT_PUBLIC_CHAT_ATTACHMENTS_ENABLED", enabled);
    mocks.session = { title: "Existing chat", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    expect(screen.queryByRole("button", { name: "Attach files" })).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("ignores file drops while production uploads are disabled", async () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("NEXT_PUBLIC_CHAT_ATTACHMENTS_ENABLED", undefined);
    mocks.session = { title: "Existing chat", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    fireEvent.drop(screen.getByRole("textbox"), { dataTransfer: {
      files: [new File(["private details"], "private.txt", { type: "text/plain" })], types: ["Files"],
    } });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTitle("private.txt")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps saved attachment cards available while new production uploads are disabled", () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("NEXT_PUBLIC_CHAT_ATTACHMENTS_ENABLED", undefined);
    mocks.session = { title: "Existing chat", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    mocks.messages = [{ storageId: "stored-user", clientId: "stored-user-client", role: "user", content: "Saved question",
      createdAt: 1, creationTime: 1, attachments: [{ id: "stored-file", filename: "saved.txt", mimeType: "text/plain", byteSize: 12, kind: "text" }] }];
    render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    expect(screen.getByTitle("saved.txt")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Attach files" })).not.toBeInTheDocument();
  });

  it("ignores pasted files while production uploads are disabled", async () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("NEXT_PUBLIC_CHAT_ATTACHMENTS_ENABLED", undefined);
    mocks.session = { title: "Existing chat", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: {
      files: [new File(["private image"], "pasted.png", { type: "image/png" })],
      items: [], getData: () => "",
    } });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTitle("pasted.png")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains removable drafts and blocks new uploads when the production flag turns off", async () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("NEXT_PUBLIC_CHAT_ATTACHMENTS_ENABLED", "1");
    mocks.session = { title: "Existing chat", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    const workspace = render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { files: [new File(["draft"], "retained.txt", { type: "text/plain" })] } });
    expect(screen.getByTitle("retained.txt")).toBeVisible();
    vi.stubEnv("NEXT_PUBLIC_CHAT_ATTACHMENTS_ENABLED", undefined);
    workspace.rerender(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    expect(screen.queryByRole("button", { name: "Attach files" })).not.toBeInTheDocument();
    expect(screen.getByTitle("retained.txt")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A question with an unuploaded draft" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", code: "Enter" });
    await act(async () => { await Promise.resolve(); });
    expect(fetch).not.toHaveBeenCalled();
    const remove = screen.getByRole("button", { name: /remove.*retained\.txt/i });
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    await waitFor(() => expect(screen.queryByTitle("retained.txt")).not.toBeInTheDocument());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the production picker available only with an explicit upload flag", () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("NEXT_PUBLIC_CHAT_ATTACHMENTS_ENABLED", "1");
    mocks.session = { title: "Existing chat", jurisdictionId: jurisdiction.id, jurisdictionName: jurisdiction.name };
    render(<ChatWorkspace chatId={chatId} initialQuery={null} />);
    expect(screen.getByRole("button", { name: "Attach files" })).toBeVisible();
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });
});
