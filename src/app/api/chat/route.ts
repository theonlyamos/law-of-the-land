import { GoogleGenAI } from "@google/genai";
import { makeFunctionReference } from "convex/server";

import { api } from "../../../../convex/_generated/api";
import { completeGovernedInteractionProofParts } from "../../../../convex/chats";
import {
  createOpaqueTelemetryToken,
  createTelemetryServiceProof,
  isOpaqueTelemetryToken,
} from "../../../../convex/lib/telemetryProof";
import {
  fetchAuthMutation,
  fetchAuthQuery,
  getToken,
  isAuthenticated,
} from "@/lib/auth-server";
import {
  DEFAULT_FILE_SEARCH_CHAT_MODEL,
  GeminiFileSearchChat,
  type ChatStore,
  type GovernedChatResult,
} from "@/lib/gemini-file-search-chat";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { CHAT_NO_EVIDENCE } from "../../../../convex/lib/chatNoEvidence";

export const runtime = "nodejs";
// Leave time for the route to close its stream before the host kills the function.
export const maxDuration = 120;

type Message = { role: "user" | "assistant"; content: string };
type ChatBody = {
  query: string;
  jurisdictionId: string;
  messages: Message[];
  externalId: string;
  assistantClientId: string;
};
type ResearchManifest = {
  authorizedScopeSize: number;
  stores: ChatStore[];
  partialCoverage: boolean;
};
type FailureCategory =
  | "authentication"
  | "configuration"
  | "network"
  | "timeout"
  | "validation"
  | "internal";
type Coverage = {
  ordinal: number;
  relation: ChatStore["relation"];
  coverage: "evidence" | "no_evidence";
};
type CompletionInput = {
  routeNonce: string;
  externalId: string;
  jurisdictionId: string;
  assistantClientId: string;
  finalAnswer?: string;
  citations: GovernedChatResult["citations"];
  model: string;
  elapsedMs: number;
  outcome: "success" | "failure" | "aborted";
  failureCategory?: FailureCategory;
  authorizedScopeSize: number;
  readyStoreCount: number;
  partialCoverage: boolean;
  jurisdictionCoverage: Coverage[];
};
type PublicCitation = {
  label: string;
  jurisdictionId: string;
  jurisdictionName: string;
  jurisdictionKind: "geographic" | "organizational";
  relation: ChatStore["relation"];
};
type CompletionResult = {
  status: "completed";
  outcome: "success";
  citations: PublicCitation[];
  partialCoverage: boolean;
  citationClaim: string;
  expiresAt: number;
};
type StreamEvent =
  | { type: "delta"; text: string }
  | {
    type: "done";
    result: string;
    citations: PublicCitation[];
    citationClaim: string;
    partialCoverage: boolean;
  }
  | { type: "error"; error: string };

const MAX_QUERY_LENGTH = 4_000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 16_000;
const MAX_ID_LENGTH = 200;
const MAX_REQUEST_BODY_BYTES = 384 * 1024;
const MAX_MANIFEST_BODY_BYTES = 16 * 1024;
const MAX_STORES = 4;
const MAX_PUBLIC_CITATIONS = 16;
const MAX_PUBLIC_CITATION_LABEL = 200;
const REQUESTS_PER_MINUTE = 15;
const MODEL_WINDOW_MS = 90_000;
const TERMINAL_WINDOW_MS = 110_000;
const CHAT_FAILURE = "We couldn't process your request. Please try again.";
const RESEARCH_UNAVAILABLE = "That jurisdiction is not available for research.";
const completeGovernedInteraction = makeFunctionReference<"mutation">(
  "chats:completeGovernedInteraction",
);

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

function boundedIdentifier(value: unknown, maximum = MAX_ID_LENGTH): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value === value.trim();
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("CHAT_REQUEST_ABORTED");
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readBoundedBody(
  request: Request | Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximumBytes) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const cancelRead = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  if (signal.aborted) {
    cancelRead();
    throw abortReason(signal);
  }
  signal.addEventListener("abort", cancelRead, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await raceWithAbort(reader.cancel(), signal);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancelRead);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseBody(bytes: Uint8Array): ChatBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (!exactKeys(value, [
    "query",
    "jurisdictionId",
    "messages",
    "externalId",
    "assistantClientId",
  ])) return null;
  if (
    typeof value.query !== "string"
    || !value.query.trim()
    || value.query.trim().length > MAX_QUERY_LENGTH
    || !boundedIdentifier(value.jurisdictionId)
    || !boundedIdentifier(value.externalId)
    || !boundedIdentifier(value.assistantClientId)
    || !Array.isArray(value.messages)
    || value.messages.length > MAX_HISTORY_MESSAGES
  ) return null;
  const messages: Message[] = [];
  for (const entry of value.messages) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const message = entry as Record<string, unknown>;
    if (
      !exactKeys(message, ["role", "content"])
      || (message.role !== "user" && message.role !== "assistant")
      || typeof message.content !== "string"
      || message.content.length > MAX_MESSAGE_LENGTH
    ) return null;
    messages.push({ role: message.role, content: message.content });
  }
  return {
    query: value.query.trim(),
    jurisdictionId: value.jurisdictionId,
    messages,
    externalId: value.externalId,
    assistantClientId: value.assistantClientId,
  };
}

function parseManifest(bytes: Uint8Array, selectedJurisdictionId: string): ResearchManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (
    !exactKeys(value, ["authorizedScopeSize", "stores", "partialCoverage"])
    || !Number.isSafeInteger(value.authorizedScopeSize)
    || (value.authorizedScopeSize as number) < 1
    || (value.authorizedScopeSize as number) > MAX_STORES
    || typeof value.partialCoverage !== "boolean"
    || !Array.isArray(value.stores)
    || value.stores.length < 1
    || value.stores.length > (value.authorizedScopeSize as number)
    || value.partialCoverage !== (value.stores.length !== value.authorizedScopeSize)
  ) return null;
  const stores: ChatStore[] = [];
  const jurisdictionIds = new Set<string>();
  const storeNames = new Set<string>();
  for (const [index, entry] of value.stores.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const store = entry as Record<string, unknown>;
    if (
      !exactKeys(store, ["jurisdictionId", "name", "kind", "relation", "storeName"])
      || !boundedIdentifier(store.jurisdictionId)
      || !boundedIdentifier(store.name)
      || !boundedIdentifier(store.storeName)
      || !/^fileSearchStores\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u.test(store.storeName)
      || (store.kind !== "geographic" && store.kind !== "organizational")
      || (store.relation !== "selected"
        && store.relation !== "geographic_ancestor"
        && store.relation !== "organizational_geography")
      || (index === 0 && (store.relation !== "selected" || store.jurisdictionId !== selectedJurisdictionId))
      || (index > 0 && store.relation === "selected")
      || jurisdictionIds.has(store.jurisdictionId)
      || storeNames.has(store.storeName)
    ) return null;
    jurisdictionIds.add(store.jurisdictionId);
    storeNames.add(store.storeName);
    stores.push({
      jurisdictionId: store.jurisdictionId,
      name: store.name,
      kind: store.kind,
      relation: store.relation,
      storeName: store.storeName,
    });
  }
  return {
    authorizedScopeSize: value.authorizedScopeSize as number,
    stores,
    partialCoverage: value.partialCoverage,
  };
}

async function loadManifest(
  jurisdictionId: string,
  token: string,
  signal: AbortSignal,
): Promise<ResearchManifest | null> {
  const site = process.env.NEXT_PUBLIC_CONVEX_SITE_URL?.replace(/\/$/u, "");
  if (!site) return null;
  const response = await raceWithAbort(
    fetch(`${site}/private/chat-research-manifest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jurisdictionId }),
      cache: "no-store",
      signal,
    }),
    signal,
  );
  if (!response.ok) return null;
  const bytes = await readBoundedBody(response, MAX_MANIFEST_BODY_BYTES, signal);
  return bytes ? parseManifest(bytes, jurisdictionId) : null;
}

function safeModelName(): string {
  return process.env.GEMINI_AI_MODEL?.trim() || DEFAULT_FILE_SEARCH_CHAT_MODEL;
}

function classifyFailure(error: unknown): FailureCategory {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof record.status === "number" ? record.status : undefined;
  const message = error instanceof Error ? error.message.toUpperCase() : "";
  if (message.includes("DEADLINE") || message.includes("TIMEOUT")) return "timeout";
  if (status === 401 || status === 403 || message.includes("PERMISSION_DENIED") || message.includes("UNAUTHENTICATED")) {
    return "authentication";
  }
  if (
    message.includes("NOT_CONFIGURED")
    || message.includes("API_KEY")
    || message.includes("MODEL_NOT_FOUND")
    || message.includes("FAILED_PRECONDITION")
  ) return "configuration";
  if (message.includes("GOVERNED_CHAT_") || message.includes("INVALID_GOVERNED_INTERACTION")) {
    return "validation";
  }
  if (error instanceof TypeError || (status !== undefined && status >= 500)) return "network";
  return "internal";
}

function coverageFor(manifest: ResearchManifest, citations: GovernedChatResult["citations"]): Coverage[] {
  const citedJurisdictions = new Set(citations.map((citation) => citation.jurisdictionId));
  return manifest.stores.map((store, ordinal) => ({
    ordinal,
    relation: store.relation,
    coverage: citedJurisdictions.has(store.jurisdictionId) ? "evidence" : "no_evidence",
  }));
}

function failureInput(
  body: ChatBody,
  manifest: ResearchManifest,
  routeNonce: string,
  model: string,
  requestStartedAt: number,
  outcome: "failure" | "aborted",
  failureCategory?: FailureCategory,
): CompletionInput {
  return {
    routeNonce,
    externalId: body.externalId,
    jurisdictionId: body.jurisdictionId,
    assistantClientId: body.assistantClientId,
    citations: [],
    model,
    elapsedMs: Math.max(0, Math.round(Date.now() - requestStartedAt)),
    outcome,
    ...(failureCategory ? { failureCategory } : {}),
    authorizedScopeSize: manifest.authorizedScopeSize,
    readyStoreCount: manifest.stores.length,
    partialCoverage: manifest.partialCoverage,
    jurisdictionCoverage: manifest.stores.map((store, ordinal) => ({
      ordinal,
      relation: store.relation,
      coverage: "no_evidence" as const,
    })),
  };
}

async function completeWithinDeadline(
  input: CompletionInput,
  terminalDeadlineAt: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (Date.now() >= terminalDeadlineAt) {
    throw new Error("CHAT_TERMINAL_DEADLINE_EXPIRED");
  }
  const proofParts = await raceWithAbort(
    completeGovernedInteractionProofParts(input),
    signal,
  );
  const serviceProof = await raceWithAbort(
    createTelemetryServiceProof(proofParts),
    signal,
  );
  if (Date.now() >= terminalDeadlineAt) {
    throw new Error("CHAT_TERMINAL_DEADLINE_EXPIRED");
  }
  return await raceWithAbort(
    fetchAuthMutation(completeGovernedInteraction, { ...input, serviceProof }),
    signal,
  );
}

function parsePublicCitation(value: unknown): PublicCitation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const citation = value as Record<string, unknown>;
  if (
    !exactKeys(citation, ["label", "jurisdictionId", "jurisdictionName", "jurisdictionKind", "relation"])
    || !boundedIdentifier(citation.label, MAX_PUBLIC_CITATION_LABEL)
    || !boundedIdentifier(citation.jurisdictionId)
    || !boundedIdentifier(citation.jurisdictionName)
    || (citation.jurisdictionKind !== "geographic" && citation.jurisdictionKind !== "organizational")
    || (citation.relation !== "selected"
      && citation.relation !== "geographic_ancestor"
      && citation.relation !== "organizational_geography")
  ) return null;
  return citation as PublicCitation;
}

function parseCompletionResult(value: unknown, selectedJurisdictionId: string, answer: string): CompletionResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (
    !exactKeys(result, [
      "status",
      "outcome",
      "citations",
      "partialCoverage",
      "citationClaim",
      "expiresAt",
    ])
    || result.status !== "completed"
    || result.outcome !== "success"
    || !Array.isArray(result.citations)
    || (result.citations.length === 0 && answer !== CHAT_NO_EVIDENCE)
    || result.citations.length > MAX_PUBLIC_CITATIONS
    || typeof result.partialCoverage !== "boolean"
    || typeof result.citationClaim !== "string"
    || !isOpaqueTelemetryToken(result.citationClaim)
    || !Number.isFinite(result.expiresAt)
  ) return null;
  const citations = result.citations.map(parsePublicCitation);
  if (
    citations.some((citation) => citation === null)
    || (citations.length > 0 && !citations.some((citation) => citation?.jurisdictionId === selectedJurisdictionId))
  ) return null;
  return { ...result, citations } as CompletionResult;
}

function streamResponse(input: {
  body: ChatBody;
  manifest: ResearchManifest;
  model: string;
  routeNonce: string;
  requestStartedAt: number;
  modelDeadlineAt: number;
  terminalDeadlineAt: number;
  clientSignal: AbortSignal;
  streamCutoffSignal: AbortSignal;
  terminalSignal: AbortSignal;
  providerSignal: AbortSignal;
  streamSignal: AbortSignal;
  abortClient: (reason: unknown) => void;
  abortStream: (reason: unknown) => void;
  modelTimer: ReturnType<typeof setTimeout>;
  terminalTimer: ReturnType<typeof setTimeout>;
  request: Request;
  detachRequestAbort: () => void;
}) {
  const encoder = new TextEncoder();
  let cancelled = input.request.signal.aborted;
  return new Response(new ReadableStream({
    start(controller) {
      const onRequestAbort = () => {
        cancelled = true;
        input.abortClient(new Error("CHAT_REQUEST_ABORTED"));
      };
      input.request.signal.addEventListener("abort", onRequestAbort, { once: true });
      const send = (event: StreamEvent) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          cancelled = true;
          input.abortClient(new Error("CHAT_STREAM_CANCELLED"));
        }
      };
      void (async () => {
        let phase = "generation";
        try {
          if (cancelled) throw new Error("CHAT_REQUEST_ABORTED");
          const apiKey = process.env.GOOGLE_AI_API_KEY;
          if (!apiKey) throw new Error("GOVERNED_CHAT_NOT_CONFIGURED");
          const chat = new GeminiFileSearchChat(new GoogleGenAI({ apiKey }), process.env);
          const result = await raceWithAbort(chat.run({
            query: input.body.query,
            stores: input.manifest.stores,
            history: input.body.messages,
          }, {
            signal: input.providerSignal,
            deadlineAt: input.terminalDeadlineAt,
            streamSignal: input.streamSignal,
            streamDeadlineAt: input.modelDeadlineAt,
            onDelta: (text) => send({ type: "delta", text }),
            onStreamComplete: () => {
              phase = "canonical_read";
              clearTimeout(input.modelTimer);
            },
          }), input.providerSignal);
          clearTimeout(input.modelTimer);
          if (cancelled || input.request.signal.aborted) throw new Error("CHAT_REQUEST_ABORTED");
          phase = "completion";
          const terminalInput: CompletionInput = {
            routeNonce: input.routeNonce,
            externalId: input.body.externalId,
            jurisdictionId: input.body.jurisdictionId,
            assistantClientId: input.body.assistantClientId,
            finalAnswer: result.answer,
            citations: result.citations,
            model: input.model,
            elapsedMs: Math.max(0, Math.round(Date.now() - input.requestStartedAt)),
            outcome: "success",
            authorizedScopeSize: input.manifest.authorizedScopeSize,
            readyStoreCount: input.manifest.stores.length,
            partialCoverage: input.manifest.partialCoverage,
            jurisdictionCoverage: coverageFor(input.manifest, result.citations),
          };
          const completed = parseCompletionResult(
            await completeWithinDeadline(
              terminalInput,
              input.terminalDeadlineAt,
              input.providerSignal,
            ),
            input.body.jurisdictionId,
            result.answer,
          );
          if (!completed) throw new Error("CHAT_TERMINAL_RESULT_INVALID");
          send({
            type: "done",
            result: result.answer,
            citations: completed.citations,
            citationClaim: completed.citationClaim,
            partialCoverage: completed.partialCoverage,
          });
          return;
        } catch (error) {
          const aborted = cancelled || input.request.signal.aborted || input.clientSignal.aborted;
          const category = (input.streamCutoffSignal.aborted || input.terminalSignal.aborted) && !aborted
            ? "timeout"
            : classifyFailure(error);
          // Do not log provider errors, prompts, answers, tokens, or store identifiers.
          if (!aborted) console.error("chat_request_failed", JSON.stringify({
            phase, category, elapsedMs: Date.now() - input.requestStartedAt,
            code: error instanceof Error && /^GOVERNED_CHAT_[A-Z_]+(?::[a-z_]+)?$/u.test(error.message)
              ? error.message : undefined,
          }));
          input.abortStream(new Error("CHAT_INTERACTION_FAILED"));
          try {
            await completeWithinDeadline(
              failureInput(
                input.body,
                input.manifest,
                input.routeNonce,
                input.model,
                input.requestStartedAt,
                aborted ? "aborted" : "failure",
                aborted ? undefined : category,
              ),
              input.terminalDeadlineAt,
              aborted ? input.terminalSignal : input.providerSignal,
            );
          } catch {
            // The client still receives only the generic terminal state.
          }
          if (!aborted) send({ type: "error", error: CHAT_FAILURE });
        } finally {
          clearTimeout(input.modelTimer);
          clearTimeout(input.terminalTimer);
          input.request.signal.removeEventListener("abort", onRequestAbort);
          input.detachRequestAbort();
          try {
            controller.close();
          } catch {
            // The consumer already cancelled the response body.
          }
        }
      })();
    },
    cancel(reason) {
      cancelled = true;
      input.abortClient(reason);
    },
  }), {
    headers: {
      "cache-control": "no-store, no-transform",
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

function jsonError(error: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error }, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

export async function POST(request: Request): Promise<Response> {
  const requestStartedAt = Date.now();
  const modelDeadlineAt = requestStartedAt + MODEL_WINDOW_MS;
  const terminalDeadlineAt = requestStartedAt + TERMINAL_WINDOW_MS;
  const clientAbort = new AbortController();
  const streamCutoffAbort = new AbortController();
  const terminalAbort = new AbortController();
  const abortClient = (reason: unknown) => {
    if (!clientAbort.signal.aborted) clientAbort.abort(reason);
  };
  const abortStream = (reason: unknown) => {
    if (!streamCutoffAbort.signal.aborted) streamCutoffAbort.abort(reason);
  };
  const onRequestAbort = () => abortClient(new Error("CHAT_REQUEST_ABORTED"));
  if (request.signal.aborted) onRequestAbort();
  else request.signal.addEventListener("abort", onRequestAbort, { once: true });
  const detachRequestAbort = () => request.signal.removeEventListener("abort", onRequestAbort);
  const providerSignal = AbortSignal.any([clientAbort.signal, terminalAbort.signal]);
  const streamSignal = AbortSignal.any([providerSignal, streamCutoffAbort.signal]);
  const modelTimer = setTimeout(() => {
    abortStream(new Error("CHAT_MODEL_DEADLINE_EXPIRED"));
  }, Math.max(0, modelDeadlineAt - Date.now()));
  const terminalTimer = setTimeout(() => {
    if (!terminalAbort.signal.aborted) {
      terminalAbort.abort(new Error("CHAT_TERMINAL_DEADLINE_EXPIRED"));
    }
  }, Math.max(0, terminalDeadlineAt - Date.now()));
  const stopEarly = (response: Response) => {
    clearTimeout(modelTimer);
    clearTimeout(terminalTimer);
    detachRequestAbort();
    return response;
  };

  try {
    if (!(await raceWithAbort(isAuthenticated(), streamSignal))) {
      return stopEarly(jsonError("Sign in to ask questions.", 401));
    }
    const limit = rateLimit(`chat:${clientKey(request)}`, REQUESTS_PER_MINUTE);
    if (!limit.ok) {
      return stopEarly(jsonError(
        "You have sent several questions in a short time. Wait a minute, then try again.",
        429,
        { "retry-after": String(limit.retryAfterSeconds) },
      ));
    }
    const bodyBytes = await readBoundedBody(request, MAX_REQUEST_BODY_BYTES, streamSignal);
    const body = bodyBytes ? parseBody(bodyBytes) : null;
    if (!body) {
      return stopEarly(jsonError(
        "That question could not be processed. Shorten it and try again.",
        400,
      ));
    }
    const allowance = await raceWithAbort(
      fetchAuthQuery(api.usage.checkAllowance, {}),
      streamSignal,
    );
    if (!allowance.allowed || !allowance.canRecord) {
      return stopEarly(jsonError(
        "You have reached your question limit for today. It resets tomorrow.",
        402,
      ));
    }
    const token = await raceWithAbort(getToken(), streamSignal);
    if (!token) return stopEarly(jsonError("Sign in to ask questions.", 401));
    let manifest: ResearchManifest | null = null;
    try {
      manifest = await raceWithAbort(
        loadManifest(body.jurisdictionId, token, streamSignal),
        streamSignal,
      );
    } catch {
      manifest = null;
    }
    if (!manifest) return stopEarly(jsonError(RESEARCH_UNAVAILABLE, 400));

    const routeNonce = createOpaqueTelemetryToken();
    try {
      await raceWithAbort(
        fetchAuthMutation(api.usage.recordQuestion, {}),
        streamSignal,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("QUOTA_EXCEEDED")) {
        return stopEarly(jsonError(
          "You have reached your question limit for today. It resets tomorrow.",
          402,
        ));
      }
      return stopEarly(jsonError(CHAT_FAILURE, 500));
    }
    return streamResponse({
      body,
      manifest,
      model: safeModelName(),
      routeNonce,
      requestStartedAt,
      modelDeadlineAt,
      terminalDeadlineAt,
      clientSignal: clientAbort.signal,
      streamCutoffSignal: streamCutoffAbort.signal,
      terminalSignal: terminalAbort.signal,
      providerSignal,
      streamSignal,
      abortClient,
      abortStream,
      modelTimer,
      terminalTimer,
      request,
      detachRequestAbort,
    });
  } catch {
    return stopEarly(jsonError(CHAT_FAILURE, 500));
  }
}
