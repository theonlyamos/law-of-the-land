import { GoogleGenAI } from "@google/genai";
import { makeFunctionReference } from "convex/server";
import { after } from "next/server";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { completeGovernedInteractionProofParts } from "../../../../convex/chats";
import { reviewedEmploymentCommitProofParts, type ReviewedEmploymentCommitInput } from "../../../../convex/reviewedEmploymentCompletion";
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
import { CHAT_POLICY_RESPONSES, isChatPolicyResponse, type ChatAnswerKind } from "../../../../convex/lib/chatPolicy";
import { emptyQueryDiagnosticExecution, validateQueryDiagnostics, type QueryDiagnostics } from "../../../../convex/lib/queryDiagnostics";
import { chatRoutingMode, classifyChatIntent, exactFormality, policyReply } from "@/lib/chat-intent-routing";
import { isDocumentQuestion } from "@/lib/chat-document-intent";
import { ChatAttachmentError, loadChatAttachmentContext, type ChatAttachmentContext } from "@/lib/chat-attachment-server";
import { MAX_CHAT_FILES } from "../../../../shared/chat-attachments";
import { publicChatErrorMessage, publicChatErrorReason, type ChatErrorReason } from "@/lib/chat-errors";
import { PILOT_CATALOG, PILOT_IDENTITY } from "@/lib/source-verification/reviewed-source-cases";
import { selectEmploymentEvidence, type EmploymentEvidenceSelection } from "@/lib/source-verification/employment-evidence";
import { createEmploymentAuthority, employmentAuthorizationReference } from "@/lib/source-verification/employment-authority";
import { createReviewedEmploymentChat, isLocalReviewedEmploymentRequest, projectReviewedEmploymentDiagnostics,
  type ReviewedEmploymentDiagnostics, type ReviewedEmploymentSelection } from "@/lib/source-verification/reviewed-employment-chat";
import { createReviewedPassageDraft } from "@/lib/source-verification/reviewed-passage-draft";
import { createGeminiEvaluationVerifier } from "@/lib/source-verification/gemini-verifier";
import { createReviewedSplitVerifier } from "@/lib/source-verification/reviewed-split-verifier";
import { prepareSplitInput } from "@/lib/source-verification/split-verification/contracts";
import { createStreamingStageExecutor } from "@/lib/source-verification/split-verification/streaming";
import { createReviewedEmploymentBackgroundAdmission, isReviewedEmploymentBackgroundRequest } from "@/lib/source-verification/reviewed-employment-background-enabled";
import { runReviewedEmploymentJob } from "@/lib/source-verification/reviewed-employment-job-worker";
import { reviewedEmploymentNextEnvironment } from "@/lib/source-verification/reviewed-employment-next-environment";
import { parseReviewedEmploymentJobProjection, reviewedEmploymentJobSubmitProofParts,
  type ReviewedEmploymentJobProjection, type ReviewedEmploymentJobSubmitInput } from "../../../../shared/reviewed-employment-jobs";
import { productionReviewedEmploymentEnabled, PRODUCTION_REVIEWED_EMPLOYMENT_POLICY } from "../../../../shared/reviewed-employment-policy";

export const runtime = "nodejs";
// Leave time for the route to close its stream before the host kills the function.
export const maxDuration = 300;

type Message = { role: "user" | "assistant"; content: string };
type ChatBody = {
  query: string;
  jurisdictionId: string;
  messages: Message[];
  externalId: string;
  assistantClientId: string;
  userClientId?: string;
  historyComplete?: boolean;
  attachmentIds?: string[];
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
  coverage: "evidence" | "no_evidence" | "not_searched";
};
const POLICY_MANIFEST: ResearchManifest = { authorizedScopeSize: 0, stores: [], partialCoverage: false };
type CompletionInput = {
  routeNonce: string;
  externalId: string;
  jurisdictionId: string;
  assistantClientId: string;
  finalAnswer?: string;
  answerKind?: ChatAnswerKind;
  citations: GovernedChatResult["citations"];
  model: string;
  elapsedMs: number;
  outcome: "success" | "failure" | "aborted";
  failureCategory?: FailureCategory;
  diagnostics?: QueryDiagnostics;
  authorizedScopeSize: number;
  readyStoreCount: number;
  partialCoverage: boolean;
  jurisdictionCoverage: Coverage[];
  attachmentIds?: string[];
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
  answerKind: ChatAnswerKind;
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
    answerKind: ChatAnswerKind;
    citations: PublicCitation[];
    citationClaim: string;
    partialCoverage: boolean;
    persisted?: true;
  }
  | { type: "error"; error: string; reason?: ChatErrorReason };

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
// Ordinary research gets 180 seconds for generation, followed by the existing
// 20-second canonical-read/completion reserve inside the 300-second host limit.
const MODEL_WINDOW_MS = 180_000;
const TERMINAL_WINDOW_MS = 200_000;
const REVIEWED_MODEL_WINDOW_MS = 90_000;
const REVIEWED_TERMINAL_WINDOW_MS = 110_000;
const CHAT_FAILURE = "We couldn't process your request. Please try again.";
const RESEARCH_UNAVAILABLE = "That jurisdiction is not available for research.";
const completeGovernedInteraction = makeFunctionReference<"mutation">(
  "chats:completeGovernedInteraction",
);
const commitReviewedEmployment = makeFunctionReference<"mutation">("reviewedEmploymentCompletion:commit");
const submitReviewedEmploymentJob = makeFunctionReference<"mutation", ReviewedEmploymentJobSubmitInput & { serviceProof: string }, ReviewedEmploymentJobProjection>("reviewedEmploymentJobs:submit");

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
    ...(Object.hasOwn(value, "userClientId") ? ["userClientId"] : []),
    ...(Object.hasOwn(value, "historyComplete") ? ["historyComplete"] : []),
    ...(Object.hasOwn(value, "attachmentIds") ? ["attachmentIds"] : []),
  ])) return null;
  if (value.attachmentIds !== undefined && (!Array.isArray(value.attachmentIds)
    || value.attachmentIds.length > MAX_CHAT_FILES
    || value.attachmentIds.some(id => !boundedIdentifier(id, 128))
    || new Set(value.attachmentIds).size !== value.attachmentIds.length)) return null;
  if (
    typeof value.query !== "string"
    || (!value.query.trim() && !(Array.isArray(value.attachmentIds) && value.attachmentIds.length > 0))
    || value.query.trim().length > MAX_QUERY_LENGTH
    || !boundedIdentifier(value.jurisdictionId)
    || !boundedIdentifier(value.externalId)
    || !boundedIdentifier(value.assistantClientId)
    || (value.userClientId !== undefined && (!boundedIdentifier(value.userClientId) || value.userClientId === value.assistantClientId))
    || (value.historyComplete !== undefined && typeof value.historyComplete !== "boolean")
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
    query: value.query.trim() || "Summarize these files.",
    jurisdictionId: value.jurisdictionId,
    messages,
    externalId: value.externalId,
    assistantClientId: value.assistantClientId,
    ...(value.userClientId === undefined ? {} : { userClientId: value.userClientId as string }),
    ...(value.historyComplete === undefined ? {} : { historyComplete: value.historyComplete as boolean }),
    ...(value.attachmentIds === undefined ? {} : { attachmentIds: value.attachmentIds as string[] }),
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

function coverageFor(manifest: ResearchManifest, citations: GovernedChatResult["citations"], notSearched = false): Coverage[] {
  const citedJurisdictions = new Set(citations.map((citation) => citation.jurisdictionId));
  return manifest.stores.map((store, ordinal) => ({
    ordinal,
    relation: store.relation,
    coverage: notSearched ? "not_searched" : citedJurisdictions.has(store.jurisdictionId) ? "evidence" : "no_evidence",
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
  attachmentIds?: string[],
  diagnostics?: QueryDiagnostics,
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
    ...(attachmentIds?.length ? { attachmentIds } : {}),
    ...(diagnostics ? { diagnostics } : {}),
    authorizedScopeSize: manifest.authorizedScopeSize,
    readyStoreCount: manifest.stores.length,
    partialCoverage: manifest.partialCoverage,
    jurisdictionCoverage: manifest.stores.map((store, ordinal) => ({
      ordinal,
      relation: store.relation,
      coverage: model === "app-policy-v1" ? "not_searched" as const : "no_evidence" as const,
    })),
  };
}

class ChatTerminalDeadlineError extends Error {
  constructor() { super("CHAT_TERMINAL_DEADLINE_EXPIRED"); }
}

async function completeWithinDeadline(
  input: CompletionInput,
  terminalDeadlineAt: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (Date.now() >= terminalDeadlineAt) {
    throw new ChatTerminalDeadlineError();
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
    throw new ChatTerminalDeadlineError();
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

function parseCompletionResult(value: unknown, selectedJurisdictionId: string, answer: string, answerKind: ChatAnswerKind): CompletionResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (
    !exactKeys(result, [
      "status",
      "outcome",
      "answerKind",
      "citations",
      "partialCoverage",
      "citationClaim",
      "expiresAt",
    ])
    || result.status !== "completed"
    || result.outcome !== "success"
    || result.answerKind !== answerKind
    || !Array.isArray(result.citations)
    || (result.citations.length === 0 && !(answerKind === "document" || (answerKind === "policy" ? isChatPolicyResponse(answer) : answer === CHAT_NO_EVIDENCE)))
    || ((answerKind === "policy" || answerKind === "document") && result.citations.length !== 0)
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
  reply: string | null;
  model: string;
  routeNonce: string;
  requestStartedAt: number;
  requestStartedMonotonic: number;
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
  attachmentContext?: ChatAttachmentContext;
  answerMode?: "legal" | "document";
  reviewed?: { selection: ReviewedEmploymentSelection; token: string };
  localDocumentSingleAttempt?: boolean;
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
        let phase: QueryDiagnostics["phase"] = "generation";
        let reviewedDiagnostics: ReviewedEmploymentDiagnostics | undefined;
        let diagnostics: QueryDiagnostics | undefined = input.reply === null ? {
          version: 1,
          phase: "generation",
          reason: "in_progress",
          searchCallCount: 0,
          searchResultCount: 0,
          searchResultItemCount: 0,
          streamedAnnotationCount: 0,
          canonicalAnnotationCount: 0,
          canonicalReadCompleted: false,
          countsClamped: false,
          execution: emptyQueryDiagnosticExecution(),
        } : undefined;
        const executionSnapshot = (terminalGuardReached = false) => ({
          ...(diagnostics?.execution ?? emptyQueryDiagnosticExecution()),
          modelDeadlineReached: diagnostics?.execution?.modelDeadlineReached === true || input.streamCutoffSignal.aborted,
          terminalDeadlineReached: terminalGuardReached || diagnostics?.execution?.terminalDeadlineReached === true || input.terminalSignal.aborted,
          clientAbortObserved: cancelled || input.request.signal.aborted || input.clientSignal.aborted,
          streamAbortObserved: diagnostics?.execution?.streamAbortObserved === true
            || (phase === "generation" && input.streamSignal.aborted),
        });
        let completionModel = input.model;
        try {
          if (cancelled) throw new Error("CHAT_REQUEST_ABORTED");
          if (cancelled || input.providerSignal.aborted) throw new Error("CHAT_REQUEST_ABORTED");
          if (input.reviewed) {
            completionModel = "gemini-3.8-flash/reviewed-employment-local";
            // Admission is checked again immediately before constructing the provider client.
            if (!isLocalReviewedEmploymentRequest(input.request, reviewedEmploymentNextEnvironment())
              || process.env.LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED !== "1"
              || !input.body.userClientId || !process.env.GOOGLE_AI_API_KEY) throw new Error("GOVERNED_CHAT_NOT_CONFIGURED");
            const credential = process.env.GOOGLE_AI_API_KEY;
            const client = new GoogleGenAI({ apiKey: credential });
            const token = input.reviewed.token;
            const authority = createEmploymentAuthority({
              authorizeSource: ({ signal, ...args }) => raceWithAbort(fetchAuthQuery(employmentAuthorizationReference, args), signal),
              loadManifest: ({ jurisdictionId, signal }) => loadManifest(jurisdictionId, token, signal),
            });
            const verifier = process.env.LOCAL_REVIEWED_EMPLOYMENT_SPLIT_ENABLED === "1"
              ? createReviewedSplitVerifier({ thinkingPolicy: "inventory_low", createExecutor: runInput => {
                const prepared = prepareSplitInput(runInput);
                if (!prepared) throw new Error("CHAT_REVIEWED_SPLIT_INPUT_INVALID");
                return createStreamingStageExecutor({ prepared, credential, fetch: globalThis.fetch, thinkingPolicy: "inventory_low",
                  entered: { wall: runInput.requestStartedAt, mono: runInput.requestStartedMonotonic } });
              } })
              : createGeminiEvaluationVerifier(client);
            const reviewed = await createReviewedEmploymentChat({ authority,
              draft: createReviewedPassageDraft(client), verifier,
              commit: async ({ answer, citations, manifest, signal }) => {
                // All model work has finished by its original cutoff. Retain the terminal reserve.
                clearTimeout(input.modelTimer); phase = "completion";
                const completion: ReviewedEmploymentCommitInput["completion"] = {
                  routeNonce: input.routeNonce, externalId: input.body.externalId, jurisdictionId: input.body.jurisdictionId,
                  assistantClientId: input.body.assistantClientId, finalAnswer: answer, answerKind: "legal", citations: [...citations],
                  model: completionModel, elapsedMs: Math.max(0, Math.round(Date.now() - input.requestStartedAt)), outcome: "success",
                  authorizedScopeSize: manifest.authorizedScopeSize, readyStoreCount: manifest.stores.length, partialCoverage: manifest.partialCoverage,
                  jurisdictionCoverage: coverageFor(manifest, [...citations]),
                  attachmentIds: (input.attachmentContext?.attachmentIds ?? []) as Id<"chatAttachments">[],
                };
                const commitInput: ReviewedEmploymentCommitInput = { completion,
                  source: { jurisdictionId: PILOT_CATALOG.jurisdictionId as Id<"jurisdictions">, resourceId: PILOT_CATALOG.resourceId as Id<"legalResources">,
                    versionId: PILOT_CATALOG.versionId as Id<"documentVersions">, expectedSha256: PILOT_IDENTITY.originalSha256,
                    expectedByteSize: PILOT_IDENTITY.originalByteLength, asOfDate: new Date().toISOString().slice(0, 10) },
                  // Prior files retain their earlier user bindings; completion binds every resolved attachment.
                  user: { clientId: input.body.userClientId!, content: input.body.query, attachmentIds: (input.body.attachmentIds ?? []) as Id<"chatAttachments">[] },
                };
                const parts = await raceWithAbort(reviewedEmploymentCommitProofParts(commitInput), signal);
                const serviceProof = await raceWithAbort(createTelemetryServiceProof(parts), signal);
                signal.throwIfAborted();
                if (Date.now() >= input.terminalDeadlineAt) throw new ChatTerminalDeadlineError();
                const committed: unknown = await raceWithAbort(fetchAuthMutation(commitReviewedEmployment, { ...commitInput, serviceProof }), signal);
                if (!committed || typeof committed !== "object" || Array.isArray(committed)
                  || !("persisted" in committed) || committed.persisted !== true) throw new Error("CHAT_PERSISTENCE_INVALID");
                const completionResult = { ...committed } as Record<string, unknown>;
                delete completionResult.persisted;
                const result = parseCompletionResult(completionResult, input.body.jurisdictionId, answer, "legal");
                if (!result) throw new Error("CHAT_TERMINAL_RESULT_INVALID");
                return { ...result, answerKind: "legal" as const, persisted: true as const };
              },
            }).run({ externalId: input.body.externalId, jurisdictionId: input.body.jurisdictionId, callsApproved: true,
              selection: input.reviewed.selection, requestStartedAt: input.requestStartedAt,
              requestStartedMonotonic: input.requestStartedMonotonic, signal: input.providerSignal });
            // Preserve only closed, content-free stage results for either terminal outcome.
            reviewedDiagnostics = projectReviewedEmploymentDiagnostics(reviewed.diagnostics);
            if (reviewed.status !== "verified") throw new Error(reviewed.reason === "deadline_exceeded"
              ? "CHAT_REVIEWED_DEADLINE_EXPIRED" : "GOVERNED_CHAT_REVIEWED_WITHHELD");
            if (cancelled || input.providerSignal.aborted) throw new Error("CHAT_REQUEST_ABORTED");
            if (reviewedDiagnostics) console.info("chat_request_completed", JSON.stringify({ reviewed: reviewedDiagnostics }));
            send({ type: "delta", text: reviewed.answer });
            send({ type: "done", result: reviewed.answer, answerKind: "legal", citations: [...reviewed.completion.citations],
              citationClaim: reviewed.completion.citationClaim, partialCoverage: reviewed.completion.partialCoverage, persisted: true });
            return;
          }
          let result: Pick<GovernedChatResult, "answer" | "citations">;
          if (input.reply !== null) {
            completionModel = "app-policy-v1";
            result = { answer: input.reply, citations: [] };
          } else {
            phase = "generation";
            if (input.localDocumentSingleAttempt && (!isLocalReviewedEmploymentRequest(input.request, reviewedEmploymentNextEnvironment())
              || process.env.LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED !== "1")) throw new Error("GOVERNED_CHAT_NOT_CONFIGURED");
            if (input.manifest.stores.length === 0 && input.answerMode !== "document") throw new Error("GOVERNED_CHAT_RESEARCH_UNAVAILABLE");
            const apiKey = process.env.GOOGLE_AI_API_KEY;
            if (!apiKey) {
              if (diagnostics) diagnostics = { ...diagnostics, reason: "not_configured" };
              throw new Error("GOVERNED_CHAT_NOT_CONFIGURED");
            }
            const chat = new GeminiFileSearchChat(new GoogleGenAI({ apiKey }), process.env);
            // Release the waiter even if generation ignores cancellation. Stream
            // completion clears its cutoff, preserving the canonical-read reserve.
            result = await raceWithAbort(chat.run({
              query: input.body.query,
              stores: input.manifest.stores,
              history: input.body.messages,
              ...(input.attachmentContext?.attachments.length ? {
                attachments: input.attachmentContext.attachments,
                answerKind: input.answerMode ?? "legal",
                selectedJurisdiction: input.attachmentContext.selectedJurisdiction,
              } : {}),
            }, {
              signal: input.providerSignal,
              deadlineAt: input.terminalDeadlineAt,
              streamSignal: input.streamSignal,
              streamDeadlineAt: input.modelDeadlineAt,
              allowStreamFileCitations: true,
              ...(input.localDocumentSingleAttempt ? { singleAttempt: true } : {}),
              // Text remains private until canonical checks and catalog authorization complete.
              onDelta: () => undefined,
              onDiagnostics: (snapshot) => {
                validateQueryDiagnostics(snapshot);
                diagnostics = { ...snapshot, ...(snapshot.execution ? { execution: { ...snapshot.execution } } : {}) };
              },
              onStreamComplete: () => {
                phase = "canonical_read";
                clearTimeout(input.modelTimer);
              },
            }), input.streamSignal);
          }
          clearTimeout(input.modelTimer);
          if (cancelled || input.request.signal.aborted) throw new Error("CHAT_REQUEST_ABORTED");
          phase = "completion";
          const answerKind: ChatAnswerKind = input.answerMode === "document" ? "document" : isChatPolicyResponse(result.answer) ? "policy" : "legal";
          const terminalInput: CompletionInput = {
            routeNonce: input.routeNonce,
            externalId: input.body.externalId,
            jurisdictionId: input.body.jurisdictionId,
            assistantClientId: input.body.assistantClientId,
            finalAnswer: result.answer,
            answerKind,
            citations: result.citations,
            model: completionModel,
            elapsedMs: Math.max(0, Math.round(Date.now() - input.requestStartedAt)),
            outcome: "success",
            ...(diagnostics ? { diagnostics: { ...diagnostics, phase, execution: executionSnapshot() } } : {}),
            authorizedScopeSize: input.manifest.authorizedScopeSize,
            readyStoreCount: input.manifest.stores.length,
            partialCoverage: input.manifest.partialCoverage,
            jurisdictionCoverage: coverageFor(input.manifest, result.citations, completionModel === "app-policy-v1"),
            ...(input.attachmentContext?.attachmentIds.length ? { attachmentIds: input.attachmentContext.attachmentIds } : {}),
          };
          const completed = parseCompletionResult(
            await completeWithinDeadline(
              terminalInput,
              input.terminalDeadlineAt,
              input.providerSignal,
            ),
            input.body.jurisdictionId,
            result.answer,
            answerKind,
          );
          if (!completed) throw new Error("CHAT_TERMINAL_RESULT_INVALID");
          // Completion rechecks current scope and file access before any answer leaves the server.
          send({ type: "delta", text: result.answer });
          send({
            type: "done",
            result: result.answer,
            answerKind,
            citations: completed.citations,
            citationClaim: completed.citationClaim,
            partialCoverage: answerKind === "legal" && completed.partialCoverage,
          });
          return;
        } catch (error) {
          const aborted = cancelled || input.request.signal.aborted || input.clientSignal.aborted;
          const category = (input.streamCutoffSignal.aborted || input.terminalSignal.aborted
            || diagnostics?.execution?.modelDeadlineReached || diagnostics?.execution?.terminalDeadlineReached
            || diagnostics?.execution?.providerFailure === "timeout") && !aborted
            ? "timeout"
            : classifyFailure(error);
          const failureDiagnostics: QueryDiagnostics | undefined = diagnostics ? {
            ...diagnostics,
            phase,
            execution: executionSnapshot(error instanceof ChatTerminalDeadlineError),
            reason: aborted ? "aborted"
              : category === "timeout" ? "deadline_exceeded"
              : phase === "completion" ? "completion_invalid"
              : diagnostics.reason === "in_progress" ? "provider_request_failed"
              : diagnostics.reason,
          } : undefined;
          // Do not log provider errors, prompts, answers, tokens, or store identifiers.
          if (!aborted) console.error("chat_request_failed", JSON.stringify({
            phase, category, elapsedMs: Date.now() - input.requestStartedAt,
            reason: failureDiagnostics?.reason,
            execution: failureDiagnostics?.execution,
            ...(reviewedDiagnostics ? { reviewed: reviewedDiagnostics } : {}),
          }));
          input.abortStream(new Error("CHAT_INTERACTION_FAILED"));
          // Only closed, actionable failures reach the client before bounded persistence.
          // Freeze their diagnostics before reader cancellation or cleanup aborts the stream.
          const publicReason = !aborted ? publicChatErrorReason(
            category === "timeout" ? "deadline_exceeded" : failureDiagnostics?.reason,
          ) : null;
          if (publicReason) send({ type: "error", error: publicChatErrorMessage(publicReason), reason: publicReason });
          try {
            await completeWithinDeadline(
              failureInput(
                input.body,
                input.manifest,
                input.routeNonce,
                completionModel,
                input.requestStartedAt,
                aborted ? "aborted" : "failure",
                aborted ? undefined : category,
                input.attachmentContext?.attachmentIds,
                failureDiagnostics,
              ),
              input.terminalDeadlineAt,
              // A client may stop reading after the terminal error. Keep that confirmed
              // failure's telemetry bounded by the terminal deadline, not reader lifetime.
              aborted || publicReason ? input.terminalSignal : input.providerSignal,
            );
          } catch {
            // Failure persistence cannot replace or delay an actionable terminal error.
          }
          if (!aborted && !publicReason) send({ type: "error", error: input.reviewed
            ? "We couldn't verify and save an answer to this question. Please try again." : CHAT_FAILURE });
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

/** The release covers the fixed section 55 request only. Other employment
 * topics and mixed questions retain the ordinary research path. */
function isProductionSection55Selection(selection: EmploymentEvidenceSelection): selection is Extract<EmploymentEvidenceSelection, { status: "selected" }> {
  return selection.status === "selected" && selection.topics.length === 1 && selection.topics[0] === "overtime"
    && selection.requests.length === 1 && selection.requests[0].pdfOrdinal === 18
    && selection.requests[0].reviewedSpanId === "p18-s55-1-2";
}

export async function POST(request: Request): Promise<Response> {
  const requestStartedAt = Date.now();
  const requestStartedMonotonic = performance.now();
  let modelDeadlineAt = requestStartedAt + MODEL_WINDOW_MS;
  let terminalDeadlineAt = requestStartedAt + TERMINAL_WINDOW_MS;
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
  let modelTimer = setTimeout(() => {
    abortStream(new Error("CHAT_MODEL_DEADLINE_EXPIRED"));
  }, Math.max(0, modelDeadlineAt - Date.now()));
  let terminalTimer = setTimeout(() => {
    if (!terminalAbort.signal.aborted) {
      terminalAbort.abort(new Error("CHAT_TERMINAL_DEADLINE_EXPIRED"));
    }
  }, Math.max(0, terminalDeadlineAt - Date.now()));
  let reviewedDeadlines = false;
  const remaining = (deadlineAt: number, windowMs: number) => Math.min(
    deadlineAt - Date.now(),
    windowMs - (performance.now() - requestStartedMonotonic),
  );
  const setReviewedDeadlines = (enabled: boolean) => {
    const expireModel = () => abortStream(new Error("CHAT_MODEL_DEADLINE_EXPIRED"));
    const expireTerminal = () => {
      if (!terminalAbort.signal.aborted) terminalAbort.abort(new Error("CHAT_TERMINAL_DEADLINE_EXPIRED"));
    };
    // Observe exhausted preparation even when a timer callback has not run.
    if (remaining(modelDeadlineAt, reviewedDeadlines ? REVIEWED_MODEL_WINDOW_MS : MODEL_WINDOW_MS) <= 0) expireModel();
    if (remaining(terminalDeadlineAt, reviewedDeadlines ? REVIEWED_TERMINAL_WINDOW_MS : TERMINAL_WINDOW_MS) <= 0) expireTerminal();
    // An ordinary fallback may regain its longer window, but cannot revive
    // preparation that already exhausted the reviewed cutoff.
    if (!enabled && streamSignal.aborted) throw abortReason(streamSignal);
    if (enabled === reviewedDeadlines) return;
    reviewedDeadlines = enabled;
    modelDeadlineAt = requestStartedAt + (enabled ? REVIEWED_MODEL_WINDOW_MS : MODEL_WINDOW_MS);
    terminalDeadlineAt = requestStartedAt + (enabled ? REVIEWED_TERMINAL_WINDOW_MS : TERMINAL_WINDOW_MS);
    clearTimeout(modelTimer);
    clearTimeout(terminalTimer);
    // Both clocks stay anchored to request entry when the scope changes.
    const modelRemaining = remaining(modelDeadlineAt, enabled ? REVIEWED_MODEL_WINDOW_MS : MODEL_WINDOW_MS);
    const terminalRemaining = remaining(terminalDeadlineAt, enabled ? REVIEWED_TERMINAL_WINDOW_MS : TERMINAL_WINDOW_MS);
    if (modelRemaining <= 0) expireModel();
    else modelTimer = setTimeout(expireModel, modelRemaining);
    if (terminalRemaining <= 0) expireTerminal();
    else terminalTimer = setTimeout(expireTerminal, terminalRemaining);
  };
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
    const localReviewedScope = process.env.NODE_ENV === "development" && process.env.LOCAL_REVIEWED_EMPLOYMENT_ENABLED === "1"
      && body.jurisdictionId === PILOT_CATALOG.jurisdictionId;
    const productionScope = productionReviewedEmploymentEnabled(reviewedEmploymentNextEnvironment())
      && body.jurisdictionId === PRODUCTION_REVIEWED_EMPLOYMENT_POLICY.jurisdictionId;
    // Avoid adding reviewed context requirements to unsupported Ghana questions.
    // Attachment-bearing requests load their context through the existing path.
    const preliminarySelection = productionScope ? selectEmploymentEvidence({ question: body.query, history: body.messages, attachments: [] }) : undefined;
    const productionCandidate = preliminarySelection !== undefined && isProductionSection55Selection(preliminarySelection);
    const reviewedScope = localReviewedScope || productionCandidate;
    if (reviewedScope) {
      // Reviewed research retains its original route deadlines and separate
      // stage budgets. Late scope discovery must never restart either clock.
      setReviewedDeadlines(true);
    }
    if (localReviewedScope && !isLocalReviewedEmploymentRequest(request, reviewedEmploymentNextEnvironment())) {
      return stopEarly(jsonError("This research option is not available here.", 403));
    }
    if (localReviewedScope && process.env.LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED !== "1") {
      return stopEarly(jsonError("This research option is not enabled yet.", 403));
    }
    let attachmentContext: ChatAttachmentContext | undefined;
    let attachmentToken: string | undefined;
    if (body.attachmentIds !== undefined || reviewedScope) {
      const token = await raceWithAbort(getToken(), streamSignal);
      if (!token) return stopEarly(jsonError("Sign in to attach files.", 401));
      attachmentToken = token;
      try {
        attachmentContext = await raceWithAbort(loadChatAttachmentContext(body.externalId, body.attachmentIds ?? [], token, streamSignal), streamSignal);
        if (attachmentContext.selectedJurisdiction.id !== body.jurisdictionId) return stopEarly(jsonError(RESEARCH_UNAVAILABLE, 400));
      } catch (error) {
        return stopEarly(jsonError(error instanceof ChatAttachmentError ? error.message : "The attachments could not be read. Please try again.", error instanceof ChatAttachmentError ? error.status : 400));
      }
    }
    const hasAttachments = Boolean(attachmentContext?.attachments.length);
    const legacyHistory = body.messages.slice(-10);
    const answerMode = hasAttachments && isDocumentQuestion(body.query, body.messages) ? "document" : "legal";
    let reviewed: { selection: ReviewedEmploymentSelection; token: string } | undefined;
    let coverageGap = false;
    if ((localReviewedScope || productionScope) && answerMode !== "document") {
      const selection = selectEmploymentEvidence({ question: body.query, history: body.messages, attachments: attachmentContext?.attachments ?? [] });
      if (localReviewedScope || isProductionSection55Selection(selection)
        || (productionCandidate && selection.status === "blocked")) {
        // Readable attachments can identify the reviewed scope only now.
        setReviewedDeadlines(true);
        if (streamSignal.aborted) throw abortReason(streamSignal);
        if (productionScope && !isReviewedEmploymentBackgroundRequest(request, reviewedEmploymentNextEnvironment())) {
          return stopEarly(jsonError("This research option is not available here.", 403));
        }
        if (!body.userClientId) return stopEarly(jsonError("Please refresh this chat and try your question again.", 400));
        if (body.historyComplete !== true) return stopEarly(jsonError(body.historyComplete === false
          ? "This conversation has more detail than this answer can safely review. Start a new chat with the relevant facts and files."
          : "Please refresh this chat and try your question again.", 400));
        if (selection.status === "blocked" && selection.reason === "no_reviewed_evidence") {
          // This is a normal, fixed answer about coverage. Give it the same bound
          // persistence claim as other policy replies, without model work or billing.
          coverageGap = true;
        } else if (selection.status !== "selected") {
          const message = selection.reason === "attachment_text_unavailable"
            ? "This legal question needs readable text from your files. Please upload a text version or paste the relevant text."
            : selection.reason === "context_limit" ? "This conversation has more detail than this answer can safely review. Start a new chat with the relevant facts and files."
            : "The reviewed material available here does not cover this question well enough to give a verified answer.";
          return stopEarly(jsonError(message, 400));
        } else {
          reviewed = { selection, token: attachmentToken! };
        }
      }
    }
    if (productionScope && !reviewed && !coverageGap) setReviewedDeadlines(false);
    const mode = chatRoutingMode();
    let reply: string | null = coverageGap ? CHAT_POLICY_RESPONSES.reviewed_coverage_gap
      : !reviewed && !hasAttachments && mode === "on" && exactFormality(body.query)
      ? policyReply("courtesy") : null;
    if (reply !== null) console.info("chat_intent_route", JSON.stringify({ mode, branch: coverageGap ? "reviewed_coverage_gap" : "courtesy", model: "app-policy-v1", elapsedMs: 0 }));
    if (!coverageGap && !reviewed && !hasAttachments && (mode === "shadow" || (mode === "on" && reply === null))) {
      const choice = await classifyChatIntent(body.query, legacyHistory, providerSignal, mode);
      if (mode === "on") reply = policyReply(choice);
    }
    let manifest: ResearchManifest = POLICY_MANIFEST;
    if (reply === null && answerMode !== "document") {
      const token = attachmentToken ?? await raceWithAbort(getToken(), streamSignal);
      if (!token) return stopEarly(jsonError("Sign in to ask questions.", 401));
      let loaded: ResearchManifest | null = null;
      try {
        loaded = await raceWithAbort(
          loadManifest(body.jurisdictionId, token, streamSignal),
          streamSignal,
        );
      } catch {
        loaded = null;
      }
      if (!loaded) return stopEarly(jsonError(RESEARCH_UNAVAILABLE, 400));
      manifest = loaded;
    }

    const routeNonce = createOpaqueTelemetryToken();
    // An in-flight production rollback must never open the synchronous verifier.
    if (reviewed && productionScope && !isReviewedEmploymentBackgroundRequest(request, reviewedEmploymentNextEnvironment())) {
      return stopEarly(jsonError("This research option is not enabled yet.", 403));
    }
    if (reviewed && isReviewedEmploymentBackgroundRequest(request, reviewedEmploymentNextEnvironment())) {
      const submission = JSON.stringify({ query: body.query, messages: body.messages, historyComplete: true,
        selection: reviewed.selection, facts: reviewed.selection.facts,
        attachmentIds: body.attachmentIds ?? [], contextAttachmentIds: attachmentContext?.attachmentIds ?? [], routeNonce });
      if (new TextEncoder().encode(submission).byteLength > MAX_REQUEST_BODY_BYTES) {
        return stopEarly(jsonError("This conversation has more detail than this answer can safely review. Start a new chat with the relevant facts and files.", 400));
      }
      const input: ReviewedEmploymentJobSubmitInput = { submissionId: body.assistantClientId, externalId: body.externalId,
        jurisdictionId: body.jurisdictionId, userClientId: body.userClientId!, assistantClientId: body.assistantClientId,
        submission, issuedAt: Date.now() };
      // Once admission is complete, saving the job and scheduling its worker are
      // one server-owned path. A browser disconnect must not orphan a queued job.
      detachRequestAbort();
      clearTimeout(modelTimer);
      clearTimeout(terminalTimer);
      const admission = createReviewedEmploymentBackgroundAdmission(requestStartedAt, requestStartedMonotonic);
      let submissionAttempted = false;
      try {
        const proofParts = await admission.run(() => reviewedEmploymentJobSubmitProofParts(input));
        const serviceProof = await admission.run(() => createTelemetryServiceProof(proofParts));
        const job = parseReviewedEmploymentJobProjection(await admission.run(() => {
          submissionAttempted = true;
          return fetchAuthMutation(submitReviewedEmploymentJob, { ...input, serviceProof });
        }));
        if (!job || job.externalId !== body.externalId || job.userClientId !== body.userClientId
          || job.assistantClientId !== body.assistantClientId || job.question !== body.query
          || (job.status !== "queued" && job.status !== "running")) throw new Error("CHAT_BACKGROUND_JOB_RESULT_INVALID");
        // The persisted job owns its deadlines and cancellation. Browser lifetime
        // ends here; after() awaits the worker independently of request.signal.
        admission.assertWithinDeadline();
        after(() => runReviewedEmploymentJob(job.jobId));
        return stopEarly(Response.json({ type: "background_job", jobId: job.jobId, status: job.status }, { status: 202,
          headers: { "cache-control": "no-store, private" } }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("QUOTA_EXCEEDED")) return stopEarly(jsonError("You have reached your question limit for today. It resets tomorrow.", 402));
        if (message.includes("REVIEWED_EMPLOYMENT_JOB_ACTIVE")) return stopEarly(jsonError("This chat is already verifying an answer. Wait for it to finish or cancel it first.", 409));
        const rejected = ["REVIEWED_EMPLOYMENT_JOB_INVALID", "REVIEWED_EMPLOYMENT_JOB_SERVICE_PROOF_INVALID",
          "REVIEWED_EMPLOYMENT_JOB_AUTHORITY_UNAVAILABLE", "REVIEWED_EMPLOYMENT_JOB_CONFLICT",
          "REVIEWED_EMPLOYMENT_JOB_ADMISSION_UNAVAILABLE"].some(code => message.includes(code));
        if (submissionAttempted && !rejected) return stopEarly(Response.json({ error: CHAT_FAILURE, type: "background_job_uncertain" }, {
          status: 500, headers: { "cache-control": "no-store, private" },
        }));
        return stopEarly(jsonError(CHAT_FAILURE, 500));
      } finally {
        admission.dispose();
      }
    }
    try {
      if (!coverageGap) await raceWithAbort(
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
      body: reviewed ? body : { ...body, messages: legacyHistory },
      manifest,
      reply,
      model: safeModelName(),
      routeNonce,
      requestStartedAt,
      requestStartedMonotonic,
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
      attachmentContext,
      answerMode,
      reviewed,
      ...(localReviewedScope && answerMode === "document" ? { localDocumentSingleAttempt: true } : {}),
    });
  } catch {
    return stopEarly(jsonError(CHAT_FAILURE, 500));
  }
}
