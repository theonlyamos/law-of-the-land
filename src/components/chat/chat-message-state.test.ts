import { describe, expect, it } from "vitest";
import {
  beginComposerBottomScroll,
  beginPrependScroll,
  canCommitRequestGeneration,
  consumeComposerBottomScroll,
  consumePrependScroll,
  reconcileChatMessages,
  routeAfterDeletingCurrentSession,
  type LocalChatMessage,
  type PersistedChatMessage,
} from "./chat-message-state";

const persisted = (overrides: Partial<PersistedChatMessage> = {}): PersistedChatMessage => ({
  storageId: "storage-1",
  clientId: null,
  role: "user",
  content: "Persisted",
  createdAt: 100,
  creationTime: 1_000,
  ...overrides,
});

const local = (overrides: Partial<LocalChatMessage> = {}): LocalChatMessage => ({
  localId: "local-1",
  clientId: "client-1",
  role: "user",
  content: "Pending",
  createdAt: 100,
  sequence: 1,
  state: "pending",
  ...overrides,
});

describe("chat message reconciliation", () => {
  it("keeps distinct persisted rows with duplicate client IDs and orders equal timestamps by server fields", () => {
    const result = reconcileChatMessages({
      persisted: [
        persisted({ storageId: "storage-b", clientId: "duplicate", creationTime: 20 }),
        persisted({ storageId: "storage-a", clientId: "duplicate", creationTime: 10 }),
      ],
      local: [],
    });

    expect(result.map((message) => message.key)).toEqual([
      "storage:storage-a",
      "storage:storage-b",
    ]);
  });

  it("replaces only a matching provisional local message while retaining pending and error rows", () => {
    const result = reconcileChatMessages({
      persisted: [persisted({ storageId: "storage-saved", clientId: "client-saved" })],
      local: [
        local({ localId: "saved", clientId: "client-saved", state: "pending" }),
        local({ localId: "error", clientId: "client-error", state: "error" }),
        local({ localId: "pending", clientId: "client-pending", state: "pending" }),
      ],
    });

    expect(result.map((message) => message.key)).toEqual([
      "storage:storage-saved",
      "local:error",
      "local:pending",
    ]);
  });
});

describe("chat scroll and route lifecycles", () => {
  it("makes a composer send authoritative over an in-flight older-page prepend until both settle", () => {
    const composer = beginComposerBottomScroll({ routeGeneration: 4 });

    const whileBothPending = consumeComposerBottomScroll(composer, {
      routeGeneration: 4,
      sendPending: true,
      loadMorePending: true,
    });
    expect(whileBothPending).toEqual({
      intent: composer,
      cancelPrepend: true,
      scrollToBottom: true,
    });

    const afterOlderPageLands = consumeComposerBottomScroll(whileBothPending.intent, {
      routeGeneration: 4,
      sendPending: true,
      loadMorePending: false,
    });
    expect(afterOlderPageLands).toEqual({
      intent: composer,
      cancelPrepend: true,
      scrollToBottom: true,
    });

    expect(
      consumeComposerBottomScroll(afterOlderPageLands.intent, {
        routeGeneration: 4,
        sendPending: false,
        loadMorePending: false,
      }),
    ).toEqual({ intent: null, cancelPrepend: true, scrollToBottom: true });
  });

  it("consumes a prepend snapshot only after the requested page adds all prior persisted rows", () => {
    const intent = beginPrependScroll({
      routeGeneration: 4,
      previousStorageIds: ["storage-2", "storage-3"],
      previousOldestServerOrderKey: {
        createdAt: 20,
        creationTime: 200,
        storageId: "storage-2",
      },
      scrollHeight: 500,
      scrollTop: 120,
    });

    expect(
      consumePrependScroll(intent, {
        routeGeneration: 4,
        serverRows: [
          { storageId: "storage-2", createdAt: 20, creationTime: 200 },
          { storageId: "storage-3", createdAt: 30, creationTime: 300 },
        ],
        scrollHeight: 550,
        loadMoreCompleted: false,
      }),
    ).toEqual({ intent, scrollTop: null });

    expect(
      consumePrependScroll(intent, {
        routeGeneration: 4,
        serverRows: [
          { storageId: "storage-1", createdAt: 10, creationTime: 100 },
          { storageId: "storage-2", createdAt: 20, creationTime: 200 },
          { storageId: "storage-3", createdAt: 30, creationTime: 300 },
        ],
        scrollHeight: 650,
        loadMoreCompleted: true,
      }),
    ).toEqual({ intent: null, scrollTop: 270 });
  });

  it("keeps a prepend intent through a reactive newer insert", () => {
    const intent = beginPrependScroll({
      routeGeneration: 4,
      previousStorageIds: ["storage-2"],
      previousOldestServerOrderKey: {
        createdAt: 20,
        creationTime: 200,
        storageId: "storage-2",
      },
      scrollHeight: 500,
      scrollTop: 120,
    });

    expect(
      consumePrependScroll(intent, {
        routeGeneration: 4,
        serverRows: [
          { storageId: "storage-2", createdAt: 20, creationTime: 200 },
          { storageId: "storage-new", createdAt: 30, creationTime: 300 },
        ],
        scrollHeight: 560,
        loadMoreCompleted: true,
      }),
    ).toEqual({ intent, scrollTop: null });
  });

  it("denies stale request completions and chooses an explicit route after deleting the current chat", () => {
    expect(canCommitRequestGeneration(3, 2)).toBe(false);
    expect(canCommitRequestGeneration(3, 3)).toBe(true);
    expect(canCommitRequestGeneration(3, 3, "chat-current", "chat-stale")).toBe(false);
    expect(routeAfterDeletingCurrentSession("chat-2", ["chat-1", "chat-2"])).toBe("/chat-1");
    expect(routeAfterDeletingCurrentSession("chat-2", ["chat-2"])).toBe("/");
  });
});
