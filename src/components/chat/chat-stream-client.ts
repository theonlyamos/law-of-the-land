import { CHAT_NO_EVIDENCE } from "../../../convex/lib/chatNoEvidence";
import { isChatPolicyResponse, type ChatAnswerKind } from "../../../convex/lib/chatPolicy";
import type { ChatCitation } from "@/lib/countries";
import { publicChatErrorReason, type ChatErrorReason } from "@/lib/chat-errors";

type ChatResponse = {
  result: string;
  answerKind: ChatAnswerKind;
  citations: ChatCitation[];
  citationClaim: string;
  partialCoverage: boolean;
  persisted?: true;
};
type BackgroundChatResponse = { type: "background_job"; jobId: string; status: "queued" | "running" };
export class ChatSubmissionTransportError extends Error {}
export class BackgroundAcknowledgementError extends Error {}
export class ApiError extends Error {
  constructor(public status: number, public serverMessage?: string, public reason?: ChatErrorReason) {
    super(serverMessage ?? `Request failed with status ${status}`);
  }
}

// The provider caps its output at 64 KiB. These limits also bound escaped JSON
// and legacy replies without retaining an unbounded network buffer or preview.
const MAX_TEXT_CHARACTERS = 100_000;
const MAX_LINE_CHARACTERS = 700_000;
const MAX_STREAM_BYTES = 1_500_000;
const MAX_STREAM_EVENTS = 100_000;

function isChatCitation(value: unknown): value is ChatCitation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const citation = value as Record<string, unknown>;
  return typeof citation.label === "string"
    && typeof citation.jurisdictionId === "string"
    && typeof citation.jurisdictionName === "string"
    && (citation.jurisdictionKind === "geographic" || citation.jurisdictionKind === "organizational")
    && (citation.relation === "selected" || citation.relation === "geographic_ancestor"
      || citation.relation === "organizational_geography");
}

function checkedResponse(event: Record<string, unknown>): ChatResponse {
  if (typeof event.result !== "string" || !event.result || event.result.length > MAX_TEXT_CHARACTERS
    || (event.answerKind !== "legal" && event.answerKind !== "policy" && event.answerKind !== "document")
    || !Array.isArray(event.citations) || !event.citations.every(isChatCitation)
    || typeof event.partialCoverage !== "boolean"
    || (event.persisted !== undefined && event.persisted !== true)
    || typeof event.citationClaim !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(event.citationClaim)
    || (event.answerKind === "policy"
      ? event.citations.length !== 0 || !isChatPolicyResponse(event.result)
      : event.answerKind === "document" ? event.citations.length !== 0
        : event.citations.length === 0 && event.result !== CHAT_NO_EVIDENCE)) {
    throw new ApiError(500, "The answer could not be verified. Please try again.");
  }
  return { result: event.result, answerKind: event.answerKind, citations: event.citations,
    citationClaim: event.citationClaim, partialCoverage: event.partialCoverage,
    ...(event.persisted === true ? { persisted: true as const } : {}) };
}

export async function postChat(
  body: unknown,
  onDraftDelta: (text: string) => void,
  signal?: AbortSignal,
  onVerifying: () => void = () => {},
  onStart: () => void = () => {},
): Promise<ChatResponse | BackgroundChatResponse> {
  let response: Response;
  try {
    response = await fetch("/api/chat", { method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify(body), signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ChatSubmissionTransportError("The submission response could not be read.");
  }
  signal?.throwIfAborted();
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: unknown; reason?: unknown; type?: unknown } | null;
    if (response.status === 500 && data?.type === "background_job_uncertain") {
      throw new BackgroundAcknowledgementError("The job acknowledgement could not be confirmed.");
    }
    throw new ApiError(response.status, typeof data?.error === "string" ? data.error : undefined,
      publicChatErrorReason(data?.reason) ?? undefined);
  }
  if (response.status === 202) {
    const data = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (data?.type !== "background_job" || typeof data.jobId !== "string" || !data.jobId
      || (data.status !== "queued" && data.status !== "running")) {
      throw new BackgroundAcknowledgementError("The job acknowledgement could not be read.");
    }
    return { type: "background_job", jobId: data.jobId, status: data.status };
  }
  if (!response.headers.get("content-type")?.includes("application/x-ndjson") || !response.body) throw new ApiError(500);

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let textCharacters = 0;
  let streamBytes = 0;
  let eventCount = 0;
  let mode: "none" | "legacy" | "provisional" = "none";
  let sawDraftDelta = false;
  let verifying = false;
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancelReader, { once: true });
  const consumeLine = (line: string): ChatResponse | null => {
    if (line.length > MAX_LINE_CHARACTERS) throw new ApiError(500);
    if (!line.trim()) return null;
    if (++eventCount > MAX_STREAM_EVENTS) throw new ApiError(500);
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new ApiError(500); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(500);
    const event = value as Record<string, unknown>;
    if (event.type === "draft_start") {
      if (mode !== "none") throw new ApiError(500);
      mode = "provisional";
      onStart();
      return null;
    }
    if (event.type === "draft_delta" || event.type === "delta") {
      if (typeof event.text !== "string" || verifying) throw new ApiError(500);
      const nextMode = event.type === "draft_delta" ? "provisional" : "legacy";
      if (mode !== "none" && mode !== nextMode) throw new ApiError(500);
      mode = nextMode;
      textCharacters += event.text.length;
      if (textCharacters > MAX_TEXT_CHARACTERS) throw new ApiError(500);
      // Reviewed and older servers' deltas stay buffered until checked done.
      if (mode === "provisional") {
        sawDraftDelta = true;
        onDraftDelta(event.text);
      }
      return null;
    }
    if (event.type === "verifying") {
      if (verifying || mode === "legacy") throw new ApiError(500);
      mode = "provisional";
      verifying = true;
      onVerifying();
      return null;
    }
    if (event.type === "done") {
      if (sawDraftDelta && !verifying) throw new ApiError(500);
      return checkedResponse(event);
    }
    if (event.type === "error" && typeof event.error === "string") {
      throw new ApiError(500, event.error, publicChatErrorReason(event.reason) ?? undefined);
    }
    throw new ApiError(500);
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      streamBytes += value?.byteLength ?? 0;
      if (streamBytes > MAX_STREAM_BYTES) throw new ApiError(500);
      buffer += decoder.decode(value, { stream: !done });
      let lineEnd = buffer.indexOf("\n");
      while (lineEnd >= 0) {
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        const completed = consumeLine(line);
        // Done is terminal after all final checks: never wait for EOF or allow
        // already-buffered records to replace this authoritative answer.
        if (completed) return completed;
        lineEnd = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE_CHARACTERS) throw new ApiError(500);
      if (done) {
        if (buffer) {
          const completed = consumeLine(buffer);
          if (completed) return completed;
        }
        throw new ApiError(500);
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    cancelReader();
    reader.releaseLock();
  }
}
