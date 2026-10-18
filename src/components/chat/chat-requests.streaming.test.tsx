import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalChatMessage } from "./chat-message-state";
import {
  ChatRequestsProvider,
  useChatDraft,
  useChatRequests,
  type DraftAttachment,
} from "./chat-requests";

vi.mock("@/lib/auth-client", () => ({ authClient: {} }));

type RequestStore = ReturnType<typeof useChatRequests>["store"];
type ChatRequest = NonNullable<ReturnType<RequestStore["start"]>>;
const stoppedMessage = "Answer stopped. No answer was saved.";
const activeTurn = { userClientId: "active-user", assistantClientId: "active-assistant" };

function wrapper({ children }: { children: React.ReactNode }) {
  return <ChatRequestsProvider>{children}</ChatRequestsProvider>;
}

function useRequests() {
  return { request: useChatRequests("chat-a"), draft: useChatDraft("chat-a") };
}

function start(store: RequestStore, id = "chat-a"): ChatRequest {
  const request = store.start(id);
  expect(request).not.toBeNull();
  return request!;
}

function stop(store: RequestStore, id = "chat-a") {
  expect(store.stop).toBeTypeOf("function");
  store.stop(id);
}

function message(
  clientId: string,
  role: LocalChatMessage["role"],
  content: string,
  sequence: number,
  state: LocalChatMessage["state"] = "pending",
): LocalChatMessage {
  return { localId: `local-${clientId}`, clientId, role, content, sequence, createdAt: sequence, state };
}

function activeMessages(): LocalChatMessage[] {
  return [
    message(activeTurn.userClientId, "user", "Current question", 3),
    { ...message(activeTurn.assistantClientId, "assistant", "Private provisional answer", 4), answerPhase: "draft" },
  ];
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ordinary chat request Stop transition", () => {
  it("retains prior verified turns and fails only the active pair", () => {
    const { result } = renderHook(useRequests, { wrapper });
    const store = result.current.request.store;
    const previous = [
      message("previous-user", "user", "Previous question", 1, "verified"),
      message("previous-assistant", "assistant", "Previous checked answer", 2, "verified"),
    ];
    const unrelated = message("unrelated-assistant", "assistant", "Other pending turn", 5);
    const ensurePromise = Promise.resolve("session-created");
    let pending!: ChatRequest;
    act(() => {
      pending = start(store);
      pending.ensurePromise = ensurePromise;
      store.update("chat-a", pending, { messages: [...previous, ...activeMessages(), unrelated], activeTurn, canStop: true });
    });

    act(() => stop(store));

    const stopped = store.get("chat-a")!;
    expect(pending.controller.signal.aborted).toBe(true);
    expect(stopped).not.toBe(pending);
    expect(stopped.controller.signal.aborted).toBe(false);
    expect(stopped.ensurePromise).toBe(ensurePromise);
    expect(result.current.request).toMatchObject({ isLoading: false, canStop: false, activeTurn: null });
    expect(result.current.request.messages.slice(0, 2)).toEqual(previous);
    expect(result.current.request.messages[2]).toMatchObject({ clientId: activeTurn.userClientId, content: "Current question", state: "error" });
    expect(result.current.request.messages[3]).toMatchObject({ clientId: activeTurn.assistantClientId, content: stoppedMessage, state: "error" });
    expect(result.current.request.messages[3].answerPhase).toBeUndefined();
    expect(result.current.request.messages[4]).toEqual(unrelated);
  });

  it("rejects updates from the stopped generation and permits a new request", () => {
    const { result } = renderHook(useRequests, { wrapper });
    const store = result.current.request.store;
    let pending!: ChatRequest;
    act(() => {
      pending = start(store);
      store.update("chat-a", pending, { messages: activeMessages(), activeTurn, canStop: true });
    });
    act(() => stop(store));
    const stoppedMessages = result.current.request.messages;

    act(() => store.update("chat-a", pending, {
      messages: [message("late-assistant", "assistant", "Late private answer", 6)],
      isLoading: true,
    }));
    expect(result.current.request.messages).toEqual(stoppedMessages);
    expect(result.current.request.isLoading).toBe(false);

    let next!: ChatRequest;
    act(() => { next = start(store); });
    expect(next.controller.signal.aborted).toBe(false);
    expect(result.current.request.messages).toEqual(stoppedMessages);
    expect(result.current.request).toMatchObject({ isLoading: true, canStop: true });
    act(() => store.update("chat-a", pending, { messages: [], isLoading: false }));
    expect(store.get("chat-a")).toBe(next);
    expect(result.current.request.messages).toEqual(stoppedMessages);
    expect(result.current.request.isLoading).toBe(true);
  });

  it("aborts attachment work and keeps a recoverable multi-file draft", () => {
    const { result } = renderHook(useRequests, { wrapper });
    const store = result.current.request.store;
    const ready: DraftAttachment = {
      localId: "ready-file", file: new File(["ready"], "ready.txt", { type: "text/plain" }), state: "ready", progress: 100,
      attachment: { id: "saved-attachment", filename: "ready.txt", mimeType: "text/plain", byteSize: 5, kind: "text" },
    };
    const uploading: DraftAttachment = {
      localId: "uploading-file", file: new File(["uploading"], "uploading.txt", { type: "text/plain" }),
      state: "uploading", progress: 57, reservedId: "reserved-upload",
    };
    const selected: DraftAttachment = {
      localId: "selected-file", file: new File(["selected"], "selected.txt", { type: "text/plain" }), state: "selected", progress: 0,
    };
    let pending!: ChatRequest;
    let uploadingOperation!: AbortController;
    let selectedOperation!: AbortController;
    act(() => {
      pending = start(store);
      store.update("chat-a", pending, { canStop: true });
      store.updateDraft("chat-a", () => ({ query: "Read my files", files: [ready, uploading, selected], error: null }));
      uploadingOperation = store.startAttachmentOperation("chat-a", uploading.localId)!;
      selectedOperation = store.startAttachmentOperation("chat-a", selected.localId)!;
    });

    act(() => stop(store));

    expect(pending.controller.signal.aborted).toBe(true);
    expect(uploadingOperation.signal.aborted).toBe(true);
    expect(selectedOperation.signal.aborted).toBe(true);
    expect(result.current.draft.draft.query).toBe("Read my files");
    expect(result.current.draft.draft.files[0]).toEqual(ready);
    expect(result.current.draft.draft.files[1]).toEqual({ ...uploading, state: "error", progress: 0, error: "Upload cancelled. Try again." });
    expect(result.current.draft.draft.files[2]).toEqual(selected);
    expect(result.current.draft.draft.error).toBeNull();

    let retryOperation!: AbortController;
    act(() => { retryOperation = store.startAttachmentOperation("chat-a", uploading.localId)!; });
    expect(retryOperation).not.toBeNull();
    act(() => store.finishAttachmentOperation("chat-a", uploading.localId, uploadingOperation));
    expect(store.startAttachmentOperation("chat-a", uploading.localId)).toBeNull();
    expect(retryOperation.signal.aborted).toBe(false);
  });

  it("shows an explicit stopped notice while session creation is still pending", () => {
    const { result } = renderHook(useRequests, { wrapper });
    const store = result.current.request.store;
    const ensurePromise = new Promise<void>(() => {});
    const selected: DraftAttachment = { localId: "selected", file: new File(["draft"], "draft.txt"), state: "selected", progress: 0 };
    let pending!: ChatRequest;
    act(() => {
      store.updateDraft("new", () => ({ query: "Question awaiting session creation", files: [selected], error: null }));
      store.transferDraftToChat("chat-a");
      pending = start(store);
      pending.ensurePromise = ensurePromise;
    });

    act(() => stop(store));

    expect(pending.controller.signal.aborted).toBe(true);
    expect(store.get("chat-a")?.ensurePromise).toBe(ensurePromise);
    expect(result.current.request).toMatchObject({ messages: [], isLoading: false, canStop: false, activeTurn: null, ensureError: stoppedMessage });
    expect(result.current.draft.draft).toEqual({ query: "Question awaiting session creation", files: [selected], error: null });
    expect(store.getDraft("new")).toEqual({ query: "", files: [], error: null });
  });

  it("stops one chat without cancelling another chat's request or attachment operation", () => {
    const { result } = renderHook(() => ({ a: useChatRequests("chat-a"), b: useChatRequests("chat-b") }), { wrapper });
    const store = result.current.a.store;
    let first!: ChatRequest;
    let second!: ChatRequest;
    let secondOperation!: AbortController;
    const secondMessages = [message("chat-b-user", "user", "Question in another chat", 1)];
    act(() => {
      first = start(store);
      second = start(store, "chat-b");
      store.update("chat-a", first, { messages: activeMessages(), activeTurn, canStop: true });
      store.update("chat-b", second, { messages: secondMessages, canStop: true });
      store.updateDraft("chat-b", () => ({ query: "Other draft", files: [{ localId: "other-file", file: new File(["other"], "other.txt"), state: "uploading", progress: 10 }], error: null }));
      secondOperation = store.startAttachmentOperation("chat-b", "other-file")!;
    });

    act(() => stop(store));

    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(false);
    expect(secondOperation.signal.aborted).toBe(false);
    expect(store.get("chat-b")).toBe(second);
    expect(result.current.b).toMatchObject({ messages: secondMessages, isLoading: true, canStop: true });
    expect(store.getDraft("chat-b").files[0]).toMatchObject({ state: "uploading", progress: 10 });
  });

  it.each(["background", "verified", "settled", "missing"] as const)("does not stop a %s request", kind => {
    const { result } = renderHook(useRequests, { wrapper });
    const store = result.current.request.store;
    let request: ChatRequest | undefined;
    act(() => {
      if (kind === "missing") return;
      request = start(store);
      store.update("chat-a", request, {
        messages: kind === "verified" ? [message("checked-assistant", "assistant", "Checked answer", 1, "verified")] : activeMessages(),
        activeTurn,
        canStop: kind === "settled",
        isLoading: kind !== "settled",
        ...(kind === "background" ? { backgroundJobId: "accepted-job" } : {}),
      });
    });
    const before = store.get("chat-a");
    const beforeState = before?.state;

    act(() => stop(store));

    expect(store.get("chat-a")).toBe(before);
    expect(store.get("chat-a")?.state).toBe(beforeState);
    if (request) expect(request.controller.signal.aborted).toBe(false);
    else expect(result.current.request).toMatchObject({ messages: [], isLoading: false });
  });
});
