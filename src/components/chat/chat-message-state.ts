import type { ChatCitation, PartialCoverage } from "@/lib/countries";

export type MessageRole = "user" | "assistant";

export interface PersistedChatMessage {
  storageId: string;
  clientId: string | null;
  role: MessageRole;
  content: string;
  createdAt: number;
  creationTime: number;
  citations?: ChatCitation[];
}

export interface LocalChatMessage {
  localId: string;
  clientId: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  sequence: number;
  state: "pending" | "error";
  citations?: ChatCitation[];
  partialCoverage?: PartialCoverage[];
}

export type DisplayChatMessage =
  | (PersistedChatMessage & { source: "persisted"; key: string })
  | (LocalChatMessage & { source: "local"; key: string });

export function reconcileChatMessages({
  persisted,
  local,
}: {
  persisted: PersistedChatMessage[];
  local: LocalChatMessage[];
}): DisplayChatMessage[] {
  const persistedByStorageId = new Map<string, PersistedChatMessage>();
  for (const message of persisted) persistedByStorageId.set(message.storageId, message);

  const matchedLocalIds = new Set<string>();
  for (const message of persistedByStorageId.values()) {
    if (!message.clientId) continue;
    const matchingLocal = local.find(
      (candidate) =>
        !matchedLocalIds.has(candidate.localId) &&
        candidate.clientId === message.clientId &&
        candidate.role === message.role,
    );
    if (matchingLocal) matchedLocalIds.add(matchingLocal.localId);
  }

  const result: DisplayChatMessage[] = [
    ...[...persistedByStorageId.values()].map((message) => ({
      ...message,
      source: "persisted" as const,
      key: `storage:${message.storageId}`,
    })),
    ...local
      .filter((message) => !matchedLocalIds.has(message.localId))
      .map((message) => ({ ...message, source: "local" as const, key: `local:${message.localId}` })),
  ];

  return result.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    if (left.source === "persisted" && right.source === "persisted") {
      return left.creationTime - right.creationTime || left.storageId.localeCompare(right.storageId);
    }
    if (left.source === "persisted") return -1;
    if (right.source === "persisted") return 1;
    return left.sequence - right.sequence || left.localId.localeCompare(right.localId);
  });
}

export interface PrependScrollIntent {
  routeGeneration: number;
  previousStorageIds: string[];
  previousOldestServerOrderKey: ServerOrderKey | null;
  scrollHeight: number;
  scrollTop: number;
}

export interface ComposerBottomScrollIntent {
  routeGeneration: number;
}

export function beginComposerBottomScroll(
  intent: ComposerBottomScrollIntent,
): ComposerBottomScrollIntent {
  return intent;
}

export function consumeComposerBottomScroll(
  intent: ComposerBottomScrollIntent | null,
  {
    routeGeneration,
    sendPending,
    loadMorePending,
  }: { routeGeneration: number; sendPending: boolean; loadMorePending: boolean },
): {
  intent: ComposerBottomScrollIntent | null;
  cancelPrepend: boolean;
  scrollToBottom: boolean;
} {
  if (!intent || intent.routeGeneration !== routeGeneration) {
    return { intent: null, cancelPrepend: false, scrollToBottom: false };
  }
  return {
    intent: sendPending || loadMorePending ? intent : null,
    cancelPrepend: true,
    scrollToBottom: true,
  };
}

export interface ServerOrderKey {
  createdAt: number;
  creationTime: number;
  storageId: string;
}

function isStrictlyOlder(left: ServerOrderKey, right: ServerOrderKey): boolean {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt;
  if (left.creationTime !== right.creationTime) return left.creationTime < right.creationTime;
  return left.storageId < right.storageId;
}

export function beginPrependScroll(intent: PrependScrollIntent): PrependScrollIntent {
  return intent;
}

export function consumePrependScroll(
  intent: PrependScrollIntent | null,
  {
    routeGeneration,
    serverRows,
    scrollHeight,
    loadMoreCompleted,
  }: {
    routeGeneration: number;
    serverRows: ServerOrderKey[];
    scrollHeight: number;
    loadMoreCompleted: boolean;
  },
): { intent: PrependScrollIntent | null; scrollTop: number | null } {
  if (!intent || intent.routeGeneration !== routeGeneration) return { intent: null, scrollTop: null };
  const storageIds = serverRows.map((row) => row.storageId);
  const retainedPreviousRows = intent.previousStorageIds.every((id) => storageIds.includes(id));
  const gainedOlderRow = intent.previousOldestServerOrderKey
    ? serverRows.some((row) => isStrictlyOlder(row, intent.previousOldestServerOrderKey!))
    : loadMoreCompleted && serverRows.length > 0;
  if (!loadMoreCompleted || !retainedPreviousRows || !gainedOlderRow) {
    return { intent, scrollTop: null };
  }
  return {
    intent: null,
    scrollTop: intent.scrollTop + (scrollHeight - intent.scrollHeight),
  };
}

export function canCommitRequestGeneration(
  activeGeneration: number,
  requestGeneration: number,
  activeExternalId?: string | null,
  requestExternalId?: string | null,
): boolean {
  return (
    activeGeneration === requestGeneration &&
    (activeExternalId === undefined || requestExternalId === undefined || activeExternalId === requestExternalId)
  );
}

export function shouldEnsureForNewSubmission({
  sessionObserved,
  isDeleted,
  isDeleting,
}: {
  sessionObserved: boolean;
  isDeleted: boolean;
  isDeleting: boolean;
}): boolean {
  return !sessionObserved && !isDeleted && !isDeleting;
}

export interface RouteEnsureEntry {
  routeGeneration: number;
  externalId: string;
  promise: Promise<unknown>;
}

function isSameRouteEnsure(left: RouteEnsureEntry, right: RouteEnsureEntry): boolean {
  return (
    left.routeGeneration === right.routeGeneration &&
    left.externalId === right.externalId &&
    left.promise === right.promise
  );
}

export function startOrReuseRouteEnsure({
  current,
  routeGeneration,
  externalId,
  start,
}: {
  current: RouteEnsureEntry | null;
  routeGeneration: number;
  externalId: string;
  start: () => Promise<unknown>;
}): RouteEnsureEntry {
  if (
    current &&
    current.routeGeneration === routeGeneration &&
    current.externalId === externalId
  ) {
    return current;
  }
  return { routeGeneration, externalId, promise: start() };
}

export function clearRejectedRouteEnsure(
  current: RouteEnsureEntry | null,
  rejected: RouteEnsureEntry,
): RouteEnsureEntry | null {
  return current && isSameRouteEnsure(current, rejected) ? null : current;
}

export async function runAfterRouteEnsure({
  ensurePromise,
  isCurrentRoute,
  run,
}: {
  ensurePromise: Promise<unknown>;
  isCurrentRoute: () => boolean;
  run: () => Promise<unknown> | unknown;
}): Promise<boolean> {
  await ensurePromise;
  if (!isCurrentRoute()) return false;
  await run();
  return true;
}

export async function runRemovalAfterRouteEnsure({
  ensurePromise,
  remove,
}: {
  ensurePromise: Promise<unknown> | null;
  remove: () => Promise<unknown> | unknown;
}): Promise<void> {
  try {
    await ensurePromise;
  } catch {
    // A failed create leaves no session to remove; still let the removal
    // mutation resolve that race as a missing-session no-op.
  }
  await remove();
}

export function routeAfterDeletingCurrentSession(
  deletedSessionId: string,
  remainingSessionIds: string[],
): string {
  return `/${remainingSessionIds.find((id) => id !== deletedSessionId) ?? ""}`.replace(/\/$/, "/");
}
