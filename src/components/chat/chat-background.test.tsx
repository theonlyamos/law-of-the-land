import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedChatMessage } from "./chat-message-state";
import type { ReviewedEmploymentJobProjection } from "../../../shared/reviewed-employment-jobs";

const mocks = vi.hoisted(() => ({ owner: "owner-1" as string | null, messages: [] as PersistedChatMessage[],
  messagesStatus: "Exhausted" as "CanLoadMore" | "LoadingMore" | "Exhausted", loadMessages: vi.fn(),
  append: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }));
vi.mock("next/image", () => ({ default: ({ alt }: { alt: string }) => <span aria-label={alt} /> }));
vi.mock("@/lib/auth-client", () => ({ authClient: { useSession: () => ({
  data: mocks.owner ? { user: { id: mocks.owner } } : null, isPending: false, error: null,
}) } }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: Boolean(mocks.owner), isLoading: false }),
  useQuery: (reference: Parameters<typeof getFunctionName>[0]) => getFunctionName(reference) === "chats:getByExternalId"
    ? { title: "Employment", jurisdictionId: "jurisdiction-1", jurisdictionName: "Ghana", jurisdictionKind: "geographic" } : undefined,
  usePaginatedQuery: (reference: Parameters<typeof getFunctionName>[0]) => getFunctionName(reference) === "chats:listMessages"
    ? { results: mocks.messages, status: mocks.messagesStatus, loadMore: mocks.loadMessages }
    : { results: [], status: "Exhausted", loadMore: vi.fn() },
  useMutation: (reference: Parameters<typeof getFunctionName>[0]) => getFunctionName(reference) === "chats:appendMessages" ? mocks.append : vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/components/jurisdictions/research-jurisdiction-picker", () => ({ ResearchJurisdictionPicker: () => null }));

import { ChatWorkspace } from "./chat-workspace";
import { ChatRequestIdentity, ChatRequestsProvider } from "./chat-requests";

const chatId = "background-chat";
const pending: ReviewedEmploymentJobProjection = { jobId: "job-1", externalId: chatId,
  userClientId: "user-turn-1", assistantClientId: "assistant-turn-1", question: "Do I need written notice?",
  status: "running", progress: "consent", createdAt: 100, verificationDeadlineAt: 240100,
  terminalDeadlineAt: 300100, errorReason: null };
let currentJob: ReviewedEmploymentJobProjection | null;
const chatPosts = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/chat" && init?.method === "POST");
const cancelPosts = () => vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/chat/background/cancel");
const view = (initialQuery: string | null = null) => render(<ChatRequestsProvider><ChatRequestIdentity />
  <ChatWorkspace chatId={chatId} initialQuery={initialQuery} /></ChatRequestsProvider>);

beforeEach(() => {
  mocks.owner = "owner-1"; mocks.messages = []; mocks.messagesStatus = "Exhausted";
  mocks.loadMessages.mockReset(); mocks.append.mockReset(); currentJob = { ...pending };
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/chat/background?")) return Response.json({ enabled: true, job: currentJob });
    if (url === "/api/chat/background/cancel") { currentJob = { ...pending, status: "cancelled", errorReason: "cancelled" }; return Response.json({ job: currentJob }); }
    return Response.json({ type: "background_job", jobId: "job-1", status: "queued" }, { status: 202 });
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("saved background verification in the chat", () => {
  it("restores a pending question on reload and never resubmits its initial query", async () => {
    view(pending.question);
    await waitFor(() => expect(screen.getByText(pending.question)).toBeVisible());
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
    expect(screen.getByText("Checking written consent.")).toBeVisible();
    expect(chatPosts()).toHaveLength(0); expect(mocks.append).not.toHaveBeenCalled();
  });

  it("replaces the placeholder only with saved messages and keeps exactly one turn after completion", async () => {
    vi.useFakeTimers();
    const rendered = view();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(pending.question)).toBeVisible();
    currentJob = { ...pending, status: "succeeded", progress: "complete" };
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.queryByText("Verified answer")).not.toBeInTheDocument();
    expect(screen.getByText("Loading the saved answer.")).toBeVisible();
    mocks.messages = [
      { storageId: "saved-user", clientId: pending.userClientId, role: "user", content: pending.question, createdAt: 100, creationTime: 100 },
      { storageId: "saved-assistant", clientId: pending.assistantClientId, role: "assistant", content: "Verified answer", createdAt: 101, creationTime: 101 },
    ];
    rendered.rerender(<ChatRequestsProvider><ChatRequestIdentity /><ChatWorkspace chatId={chatId} initialQuery={null} /></ChatRequestsProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getAllByText(pending.question)).toHaveLength(1); expect(screen.getAllByText("Verified answer")).toHaveLength(1);
    expect(screen.queryByText("Loading the saved answer.")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled(); expect(chatPosts()).toHaveLength(0); expect(mocks.append).not.toHaveBeenCalled();
  });

  it("detaches observation when leaving the view without cancelling the native job", async () => {
    vi.useFakeTimers();
    const rendered = view();
    await act(async () => { await Promise.resolve(); });
    const getCount = vi.mocked(fetch).mock.calls.length;
    expect(getCount).toBeGreaterThan(0);
    rendered.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(getCount); expect(cancelPosts()).toHaveLength(0); expect(chatPosts()).toHaveLength(0);
  });

  it("cancels the saved job only when Stop is explicitly selected", async () => {
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Stop verification" }));
    await waitFor(() => expect(screen.getByText("Verification was stopped. No answer was saved.")).toBeVisible());
    expect(cancelPosts()).toHaveLength(1); expect(JSON.parse(cancelPosts()[0][1]!.body as string)).toEqual({ jobId: pending.jobId });
    expect(chatPosts()).toHaveLength(0); expect(screen.getByRole("textbox")).toBeEnabled();
  });

  it("keeps a stopped turn terminal when the next background question starts", async () => {
    currentJob = null;
    let number = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      if (url.startsWith("/api/chat/background?")) return Response.json({ enabled: true, job: currentJob });
      if (url === "/api/chat/background/cancel") {
        currentJob = { ...currentJob!, status: "cancelled", errorReason: "cancelled" };
        return Response.json({ job: currentJob });
      }
      const body = JSON.parse(options!.body as string) as { query: string; userClientId: string; assistantClientId: string };
      number += 1;
      currentJob = { ...pending, jobId: `job-${number}`, question: body.query,
        userClientId: body.userClientId, assistantClientId: body.assistantClientId };
      return Response.json({ type: "background_job", jobId: currentJob.jobId, status: "queued" }, { status: 202 });
    }));
    view();
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "First question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop verification" }));
    await screen.findByText("Verification was stopped. No answer was saved.");
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Second question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await screen.findByText("Checking written consent.");
    expect(screen.getByText("Verification was stopped. No answer was saved.")).toBeVisible();
    expect(screen.getAllByRole("status", { name: "Preparing answer" })).toHaveLength(1);
    expect(chatPosts()).toHaveLength(2); expect(mocks.append).not.toHaveBeenCalled();
  });

  it.each(["lost-response", "malformed-ack", "uncertain-server-error"])("recovers %s through status reads while keeping the original turn pending", async failure => {
    currentJob = null;
    let releaseStatus!: () => void;
    let statusBlocked = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      if (url.startsWith("/api/chat/background?")) {
        if (statusBlocked) await new Promise<void>(resolve => { releaseStatus = () => { statusBlocked = false; resolve(); }; });
        return Response.json({ enabled: true, job: currentJob });
      }
      const body = JSON.parse(options!.body as string) as { query: string; userClientId: string; assistantClientId: string };
      currentJob = { ...pending, question: body.query, userClientId: body.userClientId, assistantClientId: body.assistantClientId };
      statusBlocked = true;
      if (failure === "lost-response") throw new TypeError("Connection lost after acceptance");
      if (failure === "uncertain-server-error") return Response.json({ error: "The answer could not finish.", type: "background_job_uncertain" }, { status: 500 });
      return new Response("invalid json", { status: 202, headers: { "content-type": "application/json" } });
    }));
    const rendered = view();
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Question with a lost acknowledgement" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("/api/chat/background?"))).toHaveLength(2));
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("status", { name: "Preparing answer" })).toBeVisible();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    await act(async () => { releaseStatus(); });
    expect(await screen.findByText("Checking written consent.")).toBeVisible();
    expect(screen.getAllByText("Question with a lost acknowledgement")).toHaveLength(1);
    expect(chatPosts()).toHaveLength(1);
    const body = JSON.parse(chatPosts()[0][1]!.body as string);
    currentJob = { ...currentJob!, status: "succeeded", progress: "complete" };
    mocks.messages = [
      { storageId: "recovered-user", clientId: body.userClientId, role: "user", content: body.query, createdAt: 100, creationTime: 100 },
      { storageId: "recovered-assistant", clientId: body.assistantClientId, role: "assistant", content: "Recovered saved answer", createdAt: 101, creationTime: 101 },
    ];
    rendered.rerender(<ChatRequestsProvider><ChatRequestIdentity /><ChatWorkspace chatId={chatId} initialQuery={null} /></ChatRequestsProvider>);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    expect(screen.getAllByText("Recovered saved answer")).toHaveLength(1); expect(chatPosts()).toHaveLength(1);
  });

  it("reconciles a saved off-view job before observing the newer job from another tab", async () => {
    currentJob = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      if (url.startsWith("/api/chat/background?")) return Response.json({ enabled: true, job: currentJob });
      const body = JSON.parse(options!.body as string) as { query: string; userClientId: string; assistantClientId: string };
      currentJob = { ...pending, question: body.query, userClientId: body.userClientId, assistantClientId: body.assistantClientId };
      return Response.json({ type: "background_job", jobId: currentJob.jobId, status: "queued" }, { status: 202 });
    }));
    const shell = (visible: boolean) => <ChatRequestsProvider><ChatRequestIdentity />{visible && <ChatWorkspace chatId={chatId} initialQuery={null} />}</ChatRequestsProvider>;
    const rendered = render(shell(true));
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "First tab question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await screen.findByText("Checking written consent.");
    const oldJob = currentJob!;
    rendered.rerender(shell(false));
    mocks.messages = [
      { storageId: "off-view-user", clientId: oldJob.userClientId, role: "user", content: oldJob.question, createdAt: 100, creationTime: 100 },
      { storageId: "off-view-assistant", clientId: oldJob.assistantClientId, role: "assistant", content: "Saved while off-view", createdAt: 101, creationTime: 101 },
    ];
    currentJob = { ...pending, jobId: "job-2", userClientId: "other-user", assistantClientId: "other-assistant", question: "Other tab question" };
    rendered.rerender(shell(true));
    expect(await screen.findByText("Other tab question")).toBeVisible();
    expect(screen.getAllByText("First tab question")).toHaveLength(1);
    expect(screen.getAllByText("Saved while off-view")).toHaveLength(1);
    expect(screen.getAllByRole("status", { name: "Preparing answer" })).toHaveLength(1);
    expect(chatPosts()).toHaveLength(1);
  });

  it("does not restore a historical succeeded job outside the loaded message page", async () => {
    currentJob = { ...pending, status: "succeeded", progress: "complete" };
    mocks.messages = Array.from({ length: 50 }, (_, index) => ({ storageId: `later-${index}`, clientId: `later-client-${index}`,
      role: index % 2 ? "assistant" : "user", content: `Later turn ${index}`, createdAt: 1000 + index, creationTime: 1000 + index }));
    view();
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    expect(screen.queryByText(pending.question)).not.toBeInTheDocument();
    expect(screen.queryByText("Loading the saved answer.")).not.toBeInTheDocument();
    expect(chatPosts()).toHaveLength(0); expect(mocks.loadMessages).not.toHaveBeenCalled();
  });

  it("loads the exact older saved assistant for a cached completed job with pagination backpressure", async () => {
    currentJob = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      if (url.startsWith("/api/chat/background?")) return Response.json({ enabled: true, job: currentJob });
      const body = JSON.parse(options!.body as string) as { query: string; userClientId: string; assistantClientId: string };
      currentJob = { ...pending, question: body.query, userClientId: body.userClientId, assistantClientId: body.assistantClientId };
      return Response.json({ type: "background_job", jobId: currentJob.jobId, status: "queued" }, { status: 202 });
    }));
    const shell = (visible: boolean) => <ChatRequestsProvider><ChatRequestIdentity />{visible && <ChatWorkspace chatId={chatId} initialQuery={null} />}</ChatRequestsProvider>;
    const rendered = render(shell(true));
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Older cached question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await screen.findByText("Checking written consent.");
    const oldJob = currentJob!; rendered.rerender(shell(false));
    currentJob = { ...oldJob, status: "succeeded", progress: "complete" };
    mocks.messages = Array.from({ length: 50 }, (_, index) => ({ storageId: `newer-${index}`, clientId: `newer-client-${index}`,
      role: index % 2 ? "assistant" : "user", content: `Newer turn ${index}`, createdAt: 1000 + index, creationTime: 1000 + index }));
    mocks.messagesStatus = "CanLoadMore";
    mocks.loadMessages.mockImplementation(() => { mocks.messagesStatus = "LoadingMore"; });
    rendered.rerender(shell(true));
    await waitFor(() => expect(mocks.loadMessages).toHaveBeenCalledExactlyOnceWith(50));
    rendered.rerender(shell(true)); expect(mocks.loadMessages).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("&job=job-1"))).toBe(true);
    mocks.messages = [...mocks.messages,
      { storageId: "older-user", clientId: oldJob.userClientId, role: "user", content: oldJob.question, createdAt: 100, creationTime: 100 },
      { storageId: "older-answer", clientId: oldJob.assistantClientId, role: "assistant", content: "Older saved answer", createdAt: 101, creationTime: 101 },
    ]; mocks.messagesStatus = "Exhausted";
    rendered.rerender(shell(true));
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    expect(screen.getAllByText("Older saved answer")).toHaveLength(1);
    expect(screen.getAllByText(oldJob.question)).toHaveLength(1);
    expect(mocks.loadMessages).toHaveBeenCalledTimes(1); expect(chatPosts()).toHaveLength(1); expect(mocks.append).not.toHaveBeenCalled();
  });

  it("releases a succeeded job whose saved assistant remains absent from exhausted native messages", async () => {
    vi.useFakeTimers(); view(); await act(async () => { await Promise.resolve(); });
    currentJob = { ...pending, status: "succeeded", progress: "complete" };
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByText("Loading the saved answer.")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.getByText("Verification finished, but we could not load its saved answer. Reload this chat or load older messages to find it.")).toBeVisible();
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.queryByRole("status", { name: "Preparing answer" })).not.toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(chatPosts()).toHaveLength(0); expect(cancelPosts()).toHaveLength(0); expect(mocks.loadMessages).not.toHaveBeenCalled();
  });

  it("bounds automatic saved-answer paging and keeps manual older-message access available", async () => {
    vi.useFakeTimers();
    mocks.messagesStatus = "CanLoadMore";
    mocks.loadMessages.mockImplementation(() => { mocks.messagesStatus = "LoadingMore"; });
    const shell = () => <ChatRequestsProvider><ChatRequestIdentity /><ChatWorkspace chatId={chatId} initialQuery={null} /></ChatRequestsProvider>;
    const rendered = render(shell()); await act(async () => { await Promise.resolve(); });
    currentJob = { ...pending, status: "succeeded", progress: "complete" };
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    for (let page = 0; page < 5; page += 1) {
      expect(mocks.loadMessages).toHaveBeenCalledTimes(page + 1);
      mocks.messages = [...mocks.messages, { storageId: `page-${page}`, clientId: `page-client-${page}`,
        role: "assistant", content: `Unrelated older answer ${page}`, createdAt: 50 - page, creationTime: 50 - page }];
      mocks.messagesStatus = "CanLoadMore"; rendered.rerender(shell());
      await act(async () => { await Promise.resolve(); });
    }
    expect(mocks.loadMessages).toHaveBeenCalledTimes(5);
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByText("Verification finished, but we could not load its saved answer. Reload this chat or load older messages to find it.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    expect(mocks.loadMessages).toHaveBeenCalledTimes(6);
    expect(chatPosts()).toHaveLength(0); expect(cancelPosts()).toHaveLength(0); expect(mocks.append).not.toHaveBeenCalled();
  });

  it("offers Stop after the lost-response lookup confirms the matching job ID", async () => {
    currentJob = null;
    let statusBlocked = false;
    let releaseStatus!: () => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      if (url.startsWith("/api/chat/background?")) {
        if (statusBlocked) await new Promise<void>(resolve => { releaseStatus = () => { statusBlocked = false; resolve(); }; });
        return Response.json({ enabled: true, job: currentJob });
      }
      if (url === "/api/chat/background/cancel") {
        statusBlocked = false;
        currentJob = { ...currentJob!, status: "cancelled", errorReason: "cancelled" };
        return Response.json({ job: currentJob });
      }
      const body = JSON.parse(options!.body as string) as { query: string; userClientId: string; assistantClientId: string };
      currentJob = { ...pending, question: body.query, userClientId: body.userClientId, assistantClientId: body.assistantClientId };
      statusBlocked = true;
      throw new TypeError("Connection lost after acceptance");
    }));
    view();
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Stop after a lost acknowledgement" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("/api/chat/background?"))).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Stop verification" })).not.toBeInTheDocument();
    expect(cancelPosts()).toHaveLength(0);
    await act(async () => { releaseStatus(); });
    fireEvent.click(await screen.findByRole("button", { name: "Stop verification" }));
    expect(await screen.findByText("Verification was stopped. No answer was saved.")).toBeVisible();
    expect(cancelPosts()).toHaveLength(1); expect(chatPosts()).toHaveLength(1);
    expect(JSON.parse(cancelPosts()[0][1]!.body as string)).toEqual({ jobId: pending.jobId });
  });

  it("recovers a new-chat lost acknowledgement using a matched job before capability has been observed", async () => {
    currentJob = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      if (url.startsWith("/api/chat/background?")) return Response.json({ enabled: true, job: currentJob });
      const body = JSON.parse(options!.body as string);
      currentJob = { ...pending, externalId: body.externalId, question: body.query,
        userClientId: body.userClientId, assistantClientId: body.assistantClientId };
      throw new TypeError("Response lost before capability was known");
    }));
    const shell = (id: string | null) => <ChatRequestsProvider><ChatRequestIdentity /><ChatWorkspace chatId={id} initialQuery={null} /></ChatRequestsProvider>;
    const rendered = render(shell(null));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New chat with a lost acknowledgement" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(chatPosts()).toHaveLength(1));
    await act(async () => { await Promise.resolve(); });
    const body = JSON.parse(chatPosts()[0][1]!.body as string);
    rendered.rerender(shell(body.externalId));
    expect(await screen.findByText("Checking written consent.")).toBeVisible();
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(chatPosts()).toHaveLength(1); expect(cancelPosts()).toHaveLength(0);
  });

  it("keeps an unconfirmed ordinary transport failure editable without background recovery", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/api/chat/background?")) return Response.json({ enabled: true, job: null });
      throw new TypeError("Submission delivery unknown");
    }));
    view(); await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unconfirmed question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("textbox")).toHaveValue("Unconfirmed question");
    expect(screen.queryByRole("button", { name: "Stop verification" })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(chatPosts()).toHaveLength(1); expect(cancelPosts()).toHaveLength(0); expect(mocks.append).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", "deadline_exceeded", "Verification reached its time limit. No answer was saved."],
    ["blocked", "verification_blocked", "The answer could not pass all verification checks. No answer was saved."],
    ["blocked", "commit_failed", "Verification finished, but the answer could not be saved. Please ask again."],
  ] as const)("shows a closed terminal message for %s/%s without a candidate answer", async (status, errorReason, message) => {
    currentJob = { ...pending, status, errorReason };
    view();
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.getByRole("textbox")).toBeEnabled(); expect(chatPosts()).toHaveLength(0); expect(mocks.append).not.toHaveBeenCalled();
  });
});


describe("scoped recovery after ordinary request transport failures", () => {
  it.each(["absent", "other-chat", "other-user", "other-assistant", "cancelled", "blocked", "expired", "status-error"])(
    "keeps the draft and input usable when the owner lookup is %s", async lookup => {
      vi.useFakeTimers(); currentJob = null;
      let submitted = false;
      vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
        if (url.startsWith("/api/chat/background?")) {
          if (!submitted) return Response.json({ enabled: true, job: null });
          if (lookup === "status-error") return Response.json({ error: "Unavailable" }, { status: 503 });
          return Response.json({ enabled: true, job: currentJob });
        }
        const body = JSON.parse(options!.body as string);
        submitted = true;
        currentJob = lookup === "absent" ? null : { ...pending, externalId: body.externalId,
          userClientId: body.userClientId, assistantClientId: body.assistantClientId, question: body.query };
        if (currentJob && lookup === "other-chat") currentJob = { ...currentJob, externalId: "other-chat" };
        if (currentJob && lookup === "other-user") currentJob = { ...currentJob, userClientId: "other-user" };
        if (currentJob && lookup === "other-assistant") currentJob = { ...currentJob, assistantClientId: "other-assistant" };
        if (currentJob && ["cancelled", "blocked", "expired"].includes(lookup)) currentJob = { ...currentJob, status: lookup as "cancelled" | "blocked" | "expired" };
        throw new TypeError("Ordinary question delivery failed");
      }));
      view(); await act(async () => { await Promise.resolve(); });
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Ordinary unrelated question" } });
      fireEvent.click(screen.getByRole("button", { name: "Send question" }));
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByRole("textbox")).toBeEnabled();
      expect(screen.getByRole("textbox")).toHaveValue("Ordinary unrelated question");
      expect(screen.queryByRole("button", { name: "Stop verification" })).not.toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(chatPosts()).toHaveLength(1); expect(cancelPosts()).toHaveLength(0); expect(mocks.append).not.toHaveBeenCalled();
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("/api/chat/background?"))).toHaveLength(2);
    });

  it.each(["queued", "running", "succeeded"] as const)("recovers an exact confirmed %s job after response loss", async status => {
    currentJob = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      if (url.startsWith("/api/chat/background?")) return Response.json({ enabled: true, job: currentJob });
      const body = JSON.parse(options!.body as string);
      currentJob = { ...pending, externalId: body.externalId, userClientId: body.userClientId,
        assistantClientId: body.assistantClientId, question: body.query, status,
        progress: status === "succeeded" ? "complete" : "consent" };
      throw new TypeError("Response lost after job acceptance");
    }));
    view(); await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Confirmed supported question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(chatPosts()).toHaveLength(1); expect(mocks.append).not.toHaveBeenCalled();
  });

  it.each(["fetch", "body"])("bounds a stalled owner lookup %s without polling or losing the draft", async stalled => {
    vi.useFakeTimers(); currentJob = null;
    let submitted = false;
    let lookupSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      if (url.startsWith("/api/chat/background?")) {
        if (!submitted) return Response.json({ enabled: true, job: null });
        lookupSignal = options?.signal as AbortSignal;
        if (stalled === "fetch") return new Promise<Response>(() => undefined);
        return { ok: true, json: () => new Promise(() => undefined) } as Response;
      }
      submitted = true; throw new TypeError("Question delivery failed");
    }));
    view(); await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Retained ordinary draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("textbox")).toBeEnabled(); expect(screen.getByRole("textbox")).toHaveValue("Retained ordinary draft");
    expect(lookupSignal?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("/api/chat/background?"))).toHaveLength(2);
    expect(chatPosts()).toHaveLength(1); expect(cancelPosts()).toHaveLength(0);
  });
});
