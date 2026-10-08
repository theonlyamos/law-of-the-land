import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  fetchAuthMutation: vi.fn(),
  fetchAuthQuery: vi.fn(),
  getToken: vi.fn(),
  isAuthenticated: vi.fn(),
}));
const rateLimitMocks = vi.hoisted(() => ({ rateLimit: vi.fn() }));
const interactionMocks = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn() }));
const attachmentMocks = vi.hoisted(() => ({ loadChatAttachmentContext: vi.fn() }));

vi.mock("@/lib/auth-server", () => authMocks);
vi.mock("@/lib/rate-limit", () => ({
  clientKey: () => "route-test-client",
  rateLimit: rateLimitMocks.rateLimit,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/chat-attachment-server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/chat-attachment-server")>(),
  loadChatAttachmentContext: attachmentMocks.loadChatAttachmentContext,
}));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    interactions = interactionMocks;
  },
}));

import { POST, maxDuration } from "./route";
import { CHAT_POLICY_RESPONSES } from "../../../../convex/lib/chatPolicy";
import { ChatAttachmentError } from "@/lib/chat-attachment-server";
import { completeGovernedInteractionProofParts } from "../../../../convex/chats";
import { verifyTelemetryServiceProof } from "../../../../convex/lib/telemetryProof";

const selectedJurisdictionId = "selected-jurisdiction-id";
const selectedResourceId = "selected-resource-id";
const selectedVersionId = "selected-version-id";
const selectedStoreName = "fileSearchStores/ghana";
const citationClaim = "c".repeat(43);

type PublicCitation = {
  label: string;
  jurisdictionId: string;
  jurisdictionName: string;
  jurisdictionKind: "geographic" | "organizational";
  relation: "selected" | "geographic_ancestor" | "organizational_geography";
};

const manifest = {
  authorizedScopeSize: 1,
  stores: [{
    jurisdictionId: selectedJurisdictionId,
    name: "Ghana",
    kind: "geographic" as const,
    relation: "selected" as const,
    storeName: "fileSearchStores/ghana",
  }],
  partialCoverage: false,
};

const publicCitation: PublicCitation = {
  label: "Labour Act, 2003, page 12",
  jurisdictionId: selectedJurisdictionId,
  jurisdictionName: "Ghana",
  jurisdictionKind: "geographic",
  relation: "selected",
};

function request(
  overrides: Record<string, unknown> = {},
  options: { signal?: AbortSignal; body?: string; contentLength?: string } = {},
) {
  const body = options.body ?? JSON.stringify({
    query: "What protection applies?",
    jurisdictionId: selectedJurisdictionId,
    messages: [],
    externalId: "chat-external-id",
    assistantClientId: "assistant-client-id",
    ...overrides,
  });
  const headers = new Headers({
    accept: "application/x-ndjson",
    "content-type": "application/json",
    "x-forwarded-for": crypto.randomUUID(),
  });
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers,
    body,
    signal: options.signal,
  });
}

function successfulStream(answer = "Employees are protected.") {
  return (async function* () {
    yield {
      event_type: "interaction.created",
      interaction: { id: "interaction-1", status: "in_progress" },
    };
    yield {
      event_type: "step.start",
      interaction_id: "interaction-1",
      index: 0,
      step: { type: "file_search_call", id: "search-call-1" },
    };
    yield { event_type: "step.stop", interaction_id: "interaction-1", index: 0 };
    yield {
      event_type: "step.start",
      interaction_id: "interaction-1",
      index: 1,
      step: { type: "file_search_result", call_id: "search-call-1" },
    };
    yield { event_type: "step.stop", interaction_id: "interaction-1", index: 1 };
    yield {
      event_type: "step.start",
      interaction_id: "interaction-1",
      index: 2,
      step: { type: "model_output" },
    };
    yield {
      event_type: "step.delta",
      interaction_id: "interaction-1",
      index: 2,
      delta: { type: "text", text: answer.slice(0, 10) },
    };
    yield {
      event_type: "step.delta",
      interaction_id: "interaction-1",
      index: 2,
      delta: { type: "text", text: answer.slice(10) },
    };
    yield { event_type: "step.stop", interaction_id: "interaction-1", index: 2 };
    yield {
      event_type: "interaction.completed",
      interaction: { id: "interaction-1", status: "completed" },
    };
  })();
}

function canonicalInteraction(
  answer = "Employees are protected.",
  citationJurisdictionId = selectedJurisdictionId,
) {
  return {
    id: "interaction-1",
    status: "completed",
    steps: [{
      type: "model_output",
      content: [{
        type: "text",
        text: answer,
        annotations: [{
          type: "file_citation",
          document_uri: selectedStoreName,
          custom_metadata: {
            jurisdiction_id: citationJurisdictionId,
            resource_id: selectedResourceId,
            version_id: selectedVersionId,
          },
          page_number: 12,
        }],
      }],
    }],
    usage: { total_input_tokens: 20, total_output_tokens: 8, total_tokens: 28 },
  };
}

async function events(response: Response) {
  const body = await response.text();
  return body.trim() ? body.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

function mutationNames() {
  return authMocks.fetchAuthMutation.mock.calls.map(([reference]) => getFunctionName(reference));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_AI_API_KEY = "test-google-key";
  process.env.GEMINI_AI_MODEL = "gemini-test-model";
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL = "https://convex.example.test";
  process.env.TELEMETRY_INGEST_SECRET = "route-test-secret-with-at-least-32-characters";
  process.env.CHAT_INTENT_ROUTING_MODE = "off";
  authMocks.isAuthenticated.mockResolvedValue(true);
  authMocks.getToken.mockResolvedValue("user-session-token");
  attachmentMocks.loadChatAttachmentContext.mockResolvedValue({ attachments: [], attachmentIds: [], selectedJurisdiction: { id: selectedJurisdictionId, name: "Ghana", kind: "geographic" } });
  authMocks.fetchAuthQuery.mockResolvedValue({
    allowed: true,
    canRecord: true,
    used: 0,
    limit: 10,
    isPro: false,
  });
  authMocks.fetchAuthMutation.mockImplementation(async (reference, args) => {
    const name = getFunctionName(reference);
    if (name === "usage:recordQuestion") return { used: 1, limit: 10, isPro: false };
    if (name === "chats:completeGovernedInteraction") {
      return {
        status: "completed",
        outcome: "success",
        answerKind: args.answerKind,
        citations: args.answerKind === "policy" || args.citations.length === 0 ? [] : [publicCitation],
        partialCoverage: false,
        citationClaim,
        expiresAt: Date.now() + 60_000,
      };
    }
    throw new Error(`Unexpected mutation: ${name}`);
  });
  rateLimitMocks.rateLimit.mockReturnValue({ ok: true, retryAfterSeconds: 0 });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(manifest)));
  interactionMocks.create.mockResolvedValue(successfulStream());
  interactionMocks.get.mockResolvedValue(canonicalInteraction());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.GOOGLE_AI_API_KEY;
  delete process.env.GEMINI_AI_MODEL;
  delete process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  delete process.env.TELEMETRY_INGEST_SECRET;
  delete process.env.CHAT_INTENT_ROUTING_MODE;
  delete process.env.TYPESAFE_API_KEY;
});

describe("POST /api/chat attachment integration", () => {
  const fileContext = {
    attachments: [{ id: "saved-file", filename: "notes.txt", mimeType: "text/plain", kind: "text", text: "The monthly rent is 900." }],
    attachmentIds: ["saved-file"],
    selectedJurisdiction: { id: selectedJurisdictionId, name: "Ghana", kind: "geographic" },
  };

  it("summarizes files without a legal store and binds all resolved files to completion", async () => {
    attachmentMocks.loadChatAttachmentContext.mockResolvedValue(fileContext);
    const canonical = canonicalInteraction("The monthly rent is 900.");
    canonical.steps[0].content[0].annotations = [];
    interactionMocks.create.mockResolvedValue(successfulStream("The monthly rent is 900."));
    interactionMocks.get.mockResolvedValue(canonical);
    const response = await POST(request({ query: "", attachmentIds: ["saved-file"] }));
    expect(response.status).toBe(200);
    expect((await events(response)).at(-1)).toMatchObject({ type: "done", answerKind: "document", result: "The monthly rent is 900.", citations: [] });
    expect(fetch).not.toHaveBeenCalled();
    expect(attachmentMocks.loadChatAttachmentContext).toHaveBeenCalledWith("chat-external-id", ["saved-file"], "user-session-token", expect.any(AbortSignal));
    const completion = authMocks.fetchAuthMutation.mock.calls.find(([reference]) => getFunctionName(reference) === "chats:completeGovernedInteraction")?.[1];
    expect(completion).toMatchObject({ answerKind: "document", attachmentIds: ["saved-file"], authorizedScopeSize: 0, readyStoreCount: 0, jurisdictionCoverage: [] });
  });

  it("resolves saved attachments on follow-up while keeping legal citations required", async () => {
    attachmentMocks.loadChatAttachmentContext.mockResolvedValue(fileContext);
    const response = await POST(request({ attachmentIds: [] }));
    expect((await events(response)).at(-1)).toMatchObject({ type: "done", answerKind: "legal", citations: [publicCitation] });
    expect(attachmentMocks.loadChatAttachmentContext.mock.calls[0][1]).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(interactionMocks.create.mock.calls[0][0])).toContain("The monthly rent is 900.");
  });

  it("rejects inaccessible files and mismatched scope before consuming quota", async () => {
    attachmentMocks.loadChatAttachmentContext.mockRejectedValueOnce(new ChatAttachmentError("Attachment unavailable.", 404));
    expect((await POST(request({ attachmentIds: ["missing"] }))).status).toBe(404);
    expect(mutationNames()).not.toContain("usage:recordQuestion");
    attachmentMocks.loadChatAttachmentContext.mockResolvedValueOnce({ ...fileContext, selectedJurisdiction: { ...fileContext.selectedJurisdiction, id: "another-jurisdiction" } });
    expect((await POST(request({ attachmentIds: [] }))).status).toBe(400);
    expect(mutationNames()).not.toContain("usage:recordQuestion");
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate or excessive attachment IDs", async () => {
    for (const attachmentIds of [["one", "one"], ["a", "b", "c", "d", "e", "f"]]) {
      expect((await POST(request({ attachmentIds }))).status).toBe(400);
    }
    expect(attachmentMocks.loadChatAttachmentContext).not.toHaveBeenCalled();
    expect(mutationNames()).not.toContain("usage:recordQuestion");
  });

  it("withholds file-derived text when access is revoked before completion", async () => {
    attachmentMocks.loadChatAttachmentContext.mockResolvedValue(fileContext);
    const original = authMocks.fetchAuthMutation.getMockImplementation()!;
    authMocks.fetchAuthMutation.mockImplementation(async (reference, args) => {
      if (getFunctionName(reference) === "chats:completeGovernedInteraction") throw new Error("CHAT_ATTACHMENT_UNAVAILABLE");
      return original(reference, args);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(request({ attachmentIds: [] }));
    const result = await events(response);
    expect(result).toEqual([{ type: "error", error: "We couldn't process your request. Please try again." }]);
  });
});

describe("POST /api/chat private query diagnostics", () => {
  function terminalArgs() {
    return authMocks.fetchAuthMutation.mock.calls.findLast(
      ([reference]) => getFunctionName(reference) === "chats:completeGovernedInteraction",
    )?.[1];
  }

  it("authorizes document/page citations from a final annotation-only step after matching the whole answer", async () => {
    const canonical = canonicalInteraction();
    canonical.steps = [
      { type: "model_output", content: [
        { type: "text", text: "Employees ", annotations: [] },
        { type: "text", text: "are protected.", annotations: [] },
      ] },
      { type: "model_output", content: [] },
    ];
    interactionMocks.get.mockResolvedValue(canonical);
    interactionMocks.create.mockResolvedValue((async function* () {
      for await (const event of successfulStream()) {
        if (event.event_type === "interaction.created") {
          yield event;
          yield { event_type: "step.start", index: 3, step: { type: "model_output", content: [] } };
          yield { event_type: "step.stop", index: 3 };
          continue;
        }
        if (event.event_type === "step.stop" && event.index === 2) {
          yield event;
          yield { event_type: "step.start", index: 4, step: { type: "model_output" } };
          yield { event_type: "step.delta", index: 4, delta: {
            type: "text_annotation_delta", annotations: [{
              type: "file_citation", document_uri: selectedStoreName,
              file_name: "Untrusted display filename.pdf",
              custom_metadata: { jurisdiction_id: selectedJurisdictionId,
                resource_id: selectedResourceId, version_id: selectedVersionId },
              start_index: 0, end_index: 9, page_number: 12,
            }],
          } };
          yield { event_type: "step.stop", index: 4 };
          continue;
        }
        yield event;
      }
    })());

    const streamEvents = await events(await POST(request()));
    const args = terminalArgs();
    expect(args).toMatchObject({ outcome: "success", citations: [{
      jurisdictionId: selectedJurisdictionId, resourceId: selectedResourceId,
      versionId: selectedVersionId, providerStoreName: selectedStoreName, pageNumber: 12,
    }] });
    expect(args.citations[0]).not.toHaveProperty("providerDocumentName");
    expect(await verifyTelemetryServiceProof(args.serviceProof,
      await completeGovernedInteractionProofParts(args))).toBe(true);
    expect(streamEvents.map(event => event.type)).toEqual(["delta", "done"]);
    expect(JSON.stringify(streamEvents)).not.toContain(selectedStoreName);
    expect(JSON.stringify(streamEvents)).not.toContain("Untrusted display filename");
  });

  it("binds a final streamed file citation to catalog completion when canonical annotations contain only URLs", async () => {
    const providerDocumentName = `${selectedStoreName}/documents/verified-document`;
    const canonical = canonicalInteraction();
    canonical.steps[0].content[0].annotations = [{
      type: "url_citation", url: "https://untrusted.example.test/reference", start_index: 0, end_index: 9,
    }] as unknown as ReturnType<typeof canonicalInteraction>["steps"][number]["content"][number]["annotations"];
    interactionMocks.get.mockResolvedValue(canonical);
    interactionMocks.create.mockResolvedValue((async function* () {
      for await (const event of successfulStream()) {
        if (event.event_type === "step.stop" && event.index === 2) {
          yield { event_type: "step.delta", index: 2, delta: {
            type: "text_annotation_delta", annotations: [{
              type: "file_citation", document_uri: providerDocumentName,
              custom_metadata: { jurisdiction_id: selectedJurisdictionId,
                resource_id: selectedResourceId, version_id: selectedVersionId },
              start_index: 0, end_index: 9, page_number: 12,
            }],
          } };
        }
        yield event;
      }
    })());

    const streamEvents = await events(await POST(request()));
    const args = terminalArgs();
    expect(args).toMatchObject({ outcome: "success", citations: [{
      jurisdictionId: selectedJurisdictionId, resourceId: selectedResourceId,
      versionId: selectedVersionId, providerStoreName: selectedStoreName, providerDocumentName,
    }] });
    expect(await verifyTelemetryServiceProof(args.serviceProof,
      await completeGovernedInteractionProofParts(args))).toBe(true);
    expect(await verifyTelemetryServiceProof(args.serviceProof,
      await completeGovernedInteractionProofParts({ ...args, citations: [{
        ...args.citations[0], providerDocumentName: `${selectedStoreName}/documents/different-document`,
      }] }))).toBe(false);
    expect(streamEvents.map(event => event.type)).toEqual(["delta", "done"]);
    expect(JSON.stringify(streamEvents)).not.toContain(providerDocumentName);
    expect(JSON.stringify(streamEvents)).not.toContain("untrusted.example.test");
  });

  it("proof-binds rejected annotation shape without disclosing provider fields", async () => {
    const privateDocument = "fileSearchStores/ghana/documents/private-document";
    const privateSource = "private-provider-source-text";
    const canonical = canonicalInteraction();
    const annotation = canonical.steps[0].content[0].annotations[0] as unknown as Record<string, unknown>;
    delete annotation.type;
    delete annotation.document_uri;
    annotation.file_name = privateDocument;
    annotation.source = privateSource;
    annotation.custom_metadata = [
      { key: "jurisdiction_id", string_value: selectedJurisdictionId },
      { key: "resource_id", string_value: selectedResourceId },
      { key: "version_id", string_value: selectedVersionId },
    ];
    interactionMocks.get.mockResolvedValue(canonical);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const streamEvents = await events(await POST(request()));
    const args = terminalArgs();

    expect(args).toMatchObject({
      outcome: "failure", failureCategory: "validation", citations: [],
      diagnostics: {
        reason: "citation_type",
        structure: {
          canonical: { annotationKinds: { missing_type: 1 } },
          rejectedCanonicalAnnotation: {
            kind: "missing_type", metadataContainer: "array",
            documentUriKind: "missing", fileNameKind: "authorized_document",
            jurisdictionMetadataPresent: true, resourceMetadataPresent: true,
            versionMetadataPresent: true, fileNamePresent: true, sourcePresent: true,
          },
        },
      },
    });
    expect(await verifyTelemetryServiceProof(args.serviceProof,
      await completeGovernedInteractionProofParts(args))).toBe(true);
    expect(await verifyTelemetryServiceProof(args.serviceProof,
      await completeGovernedInteractionProofParts({
        ...args, diagnostics: {
          ...args.diagnostics,
          structure: {
            ...args.diagnostics.structure,
            rejectedCanonicalAnnotation: {
              ...args.diagnostics.structure.rejectedCanonicalAnnotation, sourcePresent: false,
            },
          },
        },
      }))).toBe(false);
    for (const privateValue of [privateDocument, privateSource, selectedResourceId, selectedVersionId]) {
      expect(JSON.stringify(args.diagnostics)).not.toContain(privateValue);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(privateValue);
      expect(JSON.stringify(streamEvents)).not.toContain(privateValue);
    }
    expect(JSON.stringify(streamEvents)).not.toContain("rejectedCanonicalAnnotation");
    expect(streamEvents.at(-1)?.type).toBe("error");
  });

  it("binds successful diagnostics to the service proof without exposing them to the browser", async () => {
    const streamEvents = await events(await POST(request()));
    const args = terminalArgs();

    expect(args?.diagnostics).toMatchObject({
      version: 1, phase: "completion", reason: "completed",
      searchCallCount: 1, searchResultCount: 1,
      canonicalReadCompleted: true, canonicalAnnotationCount: 1,
    });
    expect(await verifyTelemetryServiceProof(
      args.serviceProof,
      await completeGovernedInteractionProofParts(args),
    )).toBe(true);
    expect(await verifyTelemetryServiceProof(
      args.serviceProof,
      await completeGovernedInteractionProofParts({
        ...args, diagnostics: { ...args.diagnostics, canonicalAnnotationCount: 0 },
      }),
    )).toBe(false);
    expect(streamEvents.at(-1)?.type).toBe("done");
    expect(JSON.stringify(streamEvents)).not.toContain("diagnostics");
    expect(JSON.stringify(streamEvents)).not.toContain("canonicalReadCompleted");
  });

  it("retains no-canonical-annotation evidence for legal abstentions", async () => {
    const canonical = canonicalInteraction();
    canonical.steps[0].content[0].annotations = [];
    interactionMocks.get.mockResolvedValue(canonical);

    const streamEvents = await events(await POST(request()));

    expect(terminalArgs()).toMatchObject({
      outcome: "success", answerKind: "legal", citations: [],
      diagnostics: {
        phase: "completion", reason: "no_canonical_annotations",
        searchCallCount: 1, searchResultCount: 1,
        streamedAnnotationCount: 0, canonicalAnnotationCount: 0,
        canonicalReadCompleted: true,
      },
    });
    expect(streamEvents.at(-1)?.type).toBe("done");
  });

  it("retains a citation rejection's structure while keeping document identifiers private", async () => {
    const documentName = "fileSearchStores/ghana/documents/private-document-identifier";
    const canonical = canonicalInteraction();
    canonical.steps[0].content[0].annotations[0].document_uri = documentName;
    canonical.steps[0].content[0].annotations[0].custom_metadata.version_id = "";
    interactionMocks.get.mockResolvedValue(canonical);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const streamEvents = await events(await POST(request()));
    const args = terminalArgs();

    expect(args).toMatchObject({
      outcome: "failure", failureCategory: "validation", citations: [],
      diagnostics: {
        phase: "canonical_read", reason: "citation_identity",
        citationUriKind: "authorized_document",
        jurisdictionMetadataPresent: false, resourceMetadataPresent: false,
        versionMetadataPresent: false, canonicalAnnotationCount: 1,
        structure: {
          rejectedCanonicalAnnotation: {
            documentUriKind: "authorized_document", metadataContainer: "object",
            jurisdictionMetadataPresent: true, resourceMetadataPresent: true,
            versionMetadataPresent: false,
          },
        },
      },
    });
    expect(streamEvents.at(-1)?.type).toBe("error");
    expect(JSON.stringify(args.diagnostics)).not.toContain(documentName);
    expect(JSON.stringify(args.diagnostics)).not.toContain(selectedResourceId);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(documentName);
    expect(JSON.stringify(streamEvents)).not.toContain("citation_identity");
  });

  it("distinguishes provider error events using a closed reason without retaining their payload", async () => {
    const privatePayload = "private-provider-error-detail";
    interactionMocks.create.mockResolvedValue((async function* () {
      yield { event_type: "error", error: { message: privatePayload } };
    })());
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const streamEvents = await events(await POST(request()));

    expect(terminalArgs()).toMatchObject({
      outcome: "failure", failureCategory: "validation",
      diagnostics: { phase: "generation", reason: "provider_error", canonicalReadCompleted: false },
    });
    expect(JSON.stringify(terminalArgs())).not.toContain(privatePayload);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(privatePayload);
    expect(streamEvents.at(-1)?.type).toBe("error");
  });

  it("does not trust a provider exception that imitates an application error code", async () => {
    const privatePayload = "GOVERNED_CHAT_PRIVATE_PROVIDER_SECRET";
    interactionMocks.create.mockRejectedValue(new Error(privatePayload));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await events(await POST(request()));

    expect(terminalArgs()?.diagnostics).toMatchObject({
      phase: "generation", reason: "provider_request_failed",
    });
    expect(JSON.stringify(terminalArgs())).not.toContain(privatePayload);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(privatePayload);
  });

  it("reports confirmed search exhaustion before failure persistence finishes, without releasing answer text", async () => {
    let finishPersistence!: () => void;
    const persistence = new Promise<void>((resolve) => { finishPersistence = resolve; });
    authMocks.fetchAuthMutation.mockImplementation(async (reference, args) => {
      if (getFunctionName(reference) === "usage:recordQuestion") return { used: 1, limit: 10, isPro: false };
      await persistence;
      return { status: "completed", outcome: args.outcome };
    });
    interactionMocks.create.mockResolvedValue((async function* () {
      yield { event_type: "interaction.created", interaction: { id: "interaction-1", status: "in_progress" } };
      for (let index = 0; index < 21; index++) {
        yield { event_type: "step.start", interaction_id: "interaction-1", index: index * 2,
          step: { type: "file_search_call", id: `search-${index}` } };
        yield { event_type: "step.stop", interaction_id: "interaction-1", index: index * 2 };
        yield { event_type: "step.start", interaction_id: "interaction-1", index: index * 2 + 1,
          step: { type: "file_search_result", call_id: `search-${index}` } };
        yield { event_type: "step.stop", interaction_id: "interaction-1", index: index * 2 + 1 };
      }
    })());
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reader = (await POST(request())).body!.getReader();
    let first: ReadableStreamReadResult<Uint8Array> | undefined;
    const firstRead = reader.read().then((value) => { first = value; });
    try {
      await vi.waitFor(() => expect(first).toBeDefined());
      expect(JSON.parse(new TextDecoder().decode(first!.value))).toEqual({
        type: "error", reason: "file_search_budget_exhausted",
        error: expect.stringContaining("Each answer has its own search limit"),
      });
      // The client stops reading as soon as it receives the terminal failure.
      await reader.cancel();
      await vi.waitFor(() => expect(terminalArgs()).toMatchObject({
        outcome: "failure", failureCategory: "validation", citations: [],
        diagnostics: { reason: "file_search_budget_exhausted", searchCallCount: 20, canonicalReadCompleted: false },
      }));
      expect(terminalArgs().finalAnswer).toBeUndefined();
      expect(interactionMocks.get).not.toHaveBeenCalled();
    } finally {
      finishPersistence();
      await firstRead;
      await reader.cancel();
    }
  });

  it("does not expose search-limit handling for a provider exception with that text", async () => {
    interactionMocks.create.mockRejectedValue(new Error("GOVERNED_CHAT_file_search_budget_exhausted"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const streamEvents = await events(await POST(request()));
    expect(streamEvents).toEqual([{ type: "error", error: "We couldn't process your request. Please try again." }]);
    expect(terminalArgs().diagnostics.reason).toBe("provider_request_failed");
  });

  it.each([408, 504])("reports provider timeout status %s without claiming an application deadline", async (status) => {
    const privatePayload = "private provider message and document reference";
    interactionMocks.create.mockRejectedValue(Object.assign(new Error(privatePayload), { status }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const streamEvents = await events(await POST(request()));

    expect(streamEvents).toEqual([{
      type: "error", reason: "deadline_exceeded",
      error: "This answer took too long and could not be verified. You can ask a more focused question or try again later.",
    }]);
    const args = terminalArgs();
    expect(args).toMatchObject({
      outcome: "failure", failureCategory: "timeout", citations: [],
      diagnostics: { reason: "deadline_exceeded", execution: {
        modelDeadlineReached: false, terminalDeadlineReached: false, clientAbortObserved: false,
        streamAbortObserved: false, providerFailure: "timeout", completionEventAccepted: false,
        streamClosed: false, resumeAttempted: false, resumeOutcome: "not_attempted",
      } },
    });
    expect(args.finalAnswer).toBeUndefined();
    expect(JSON.stringify([args, errorLog.mock.calls, streamEvents])).not.toContain(privatePayload);
    expect(JSON.stringify(streamEvents)).not.toContain("execution");
  });

  it("delivers timeout guidance before failure persistence and preserves the original cause after reader cancellation", async () => {
    let finishPersistence!: () => void;
    const persistence = new Promise<void>((resolve) => { finishPersistence = resolve; });
    authMocks.fetchAuthMutation.mockImplementation(async (reference) => {
      if (getFunctionName(reference) === "usage:recordQuestion") return { used: 1, limit: 10, isPro: false };
      return await persistence;
    });
    interactionMocks.create.mockRejectedValue(Object.assign(new Error("provider request exceeded its time limit"), { status: 504 }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(request());
    const reader = response.body!.getReader();
    let first: ReadableStreamReadResult<Uint8Array> | undefined;
    const read = reader.read().then(value => { first = value; });
    try {
      await vi.waitFor(() => expect(first).toBeDefined());
      expect(JSON.parse(new TextDecoder().decode(first!.value))).toMatchObject({ type: "error", reason: "deadline_exceeded" });
      await reader.cancel();
      await vi.waitFor(() => expect(terminalArgs()).toMatchObject({ outcome: "failure", diagnostics: {
        reason: "deadline_exceeded", execution: { providerFailure: "timeout", clientAbortObserved: false, modelDeadlineReached: false },
      } }));
      expect(terminalArgs().finalAnswer).toBeUndefined();
    } finally {
      finishPersistence();
      await read;
    }
  });

  it("records missing provider configuration before attempting a provider request", async () => {
    delete process.env.GOOGLE_AI_API_KEY;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const streamEvents = await events(await POST(request()));

    expect(terminalArgs()).toMatchObject({
      outcome: "failure", failureCategory: "configuration",
      diagnostics: {
        phase: "generation", reason: "not_configured",
        searchCallCount: 0, searchResultCount: 0, canonicalReadCompleted: false,
      },
    });
    expect(interactionMocks.create).not.toHaveBeenCalled();
    expect(streamEvents.at(-1)?.type).toBe("error");
  });

  it("retains the canonical-read phase and prior search counts when the canonical request fails", async () => {
    interactionMocks.get.mockRejectedValue(new Error("private-canonical-error"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await events(await POST(request()));

    expect(terminalArgs()?.diagnostics).toMatchObject({
      phase: "canonical_read", reason: "provider_request_failed",
      searchCallCount: 1, searchResultCount: 1, canonicalReadCompleted: false,
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private-canonical-error");
  });

  it("distinguishes a rejected completion from a provider parser failure", async () => {
    authMocks.fetchAuthMutation.mockImplementation(async (reference, args) => {
      if (getFunctionName(reference) === "usage:recordQuestion") return { used: 1, limit: 10, isPro: false };
      if (args.outcome === "success") throw new Error("INVALID_GOVERNED_INTERACTION");
      return { status: "completed", outcome: "failure" };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const streamEvents = await events(await POST(request()));

    expect(terminalArgs()).toMatchObject({
      outcome: "failure", failureCategory: "validation",
      diagnostics: {
        phase: "completion", reason: "completion_invalid",
        canonicalReadCompleted: true, canonicalAnnotationCount: 1,
      },
    });
    expect(streamEvents.at(-1)?.type).toBe("error");
    expect(streamEvents.some((event) => event.type === "done")).toBe(false);
    expect(streamEvents.some((event) => event.type === "delta")).toBe(false);
  });
});

describe("POST /api/chat request boundary", () => {
  it("bounds a stalled authentication preflight by the shared model cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
    let releaseAuthentication!: (authenticated: boolean) => void;
    authMocks.isAuthenticated.mockReturnValue(new Promise((resolve) => {
      releaseAuthentication = resolve;
    }));

    const responsePromise = POST(request());
    await vi.advanceTimersByTimeAsync(90_000);
    let response: Response | null = null;
    try {
      response = await Promise.race([responsePromise, Promise.resolve(null)]);
      expect(response).not.toBeNull();
      expect(response?.status).toBe(500);
    } finally {
      if (!response) {
        releaseAuthentication(true);
        await responsePromise;
      }
    }
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it("cancels and bounds a stalled request body read by the shared model cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const cancelBody = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        controller.enqueue(new TextEncoder().encode('{"query":'));
      },
      cancel: cancelBody,
    });
    const stalledRequest = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: {
        accept: "application/x-ndjson",
        "content-type": "application/json",
        "x-forwarded-for": crypto.randomUUID(),
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const responsePromise = POST(stalledRequest);
    await vi.advanceTimersByTimeAsync(90_000);
    let response: Response | null = null;
    try {
      response = await Promise.race([responsePromise, Promise.resolve(null)]);
      expect(response).not.toBeNull();
      expect(response?.status).toBe(500);
      expect(cancelBody).toHaveBeenCalledTimes(1);
    } finally {
      if (!response) {
        bodyController.close();
        await responsePromise;
      }
    }
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests before reading or charging them", async () => {
    authMocks.isAuthenticated.mockResolvedValue(false);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(authMocks.getToken).not.toHaveBeenCalled();
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it("enforces the route rate limit before provider work", async () => {
    rateLimitMocks.rateLimit.mockReturnValue({ ok: false, retryAfterSeconds: 17 });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(authMocks.getToken).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it.each([
    ["context", "untrusted context"],
    ["country", "GH"],
    ["legacyCountryCode", "GH"],
    ["stores", [{ storeName: "fileSearchStores/forged" }]],
    ["supplementaryStores", ["fileSearchStores/forged"]],
    ["arbitrary", true],
  ])("rejects the removed or arbitrary %s field", async (key, value) => {
    const response = await POST(request({ [key]: value }));

    expect(response.status).toBe(400);
    expect(authMocks.getToken).not.toHaveBeenCalled();
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it.each([
    ["missing query", { query: undefined }],
    ["empty query", { query: "   " }],
    ["oversized query", { query: "q".repeat(4_001) }],
    ["missing jurisdiction", { jurisdictionId: undefined }],
    ["missing messages", { messages: undefined }],
    ["too many messages", { messages: Array.from({ length: 21 }, () => ({ role: "user", content: "x" })) }],
    ["invalid message role", { messages: [{ role: "system", content: "x" }] }],
    ["oversized message", { messages: [{ role: "user", content: "x".repeat(16_001) }] }],
    ["missing chat ID", { externalId: undefined }],
    ["oversized chat ID", { externalId: "x".repeat(201) }],
    ["missing assistant ID", { assistantClientId: undefined }],
    ["oversized assistant ID", { assistantClientId: "x".repeat(201) }],
  ])("rejects %s before provider work", async (_label, overrides) => {
    const response = await POST(request(overrides));

    expect(response.status).toBe(400);
    expect(authMocks.getToken).not.toHaveBeenCalled();
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it("rejects an oversized raw body without calling Request.json", async () => {
    const oversized = request({}, { body: `{"padding":"${"x".repeat(400_000)}"}` });
    const jsonSpy = vi.spyOn(oversized, "json").mockRejectedValue(new Error("Request.json must not run"));

    const response = await POST(oversized);

    expect(response.status).toBe(400);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(authMocks.getToken).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it("rejects quota exhaustion atomically before calling Gemini", async () => {
    authMocks.fetchAuthMutation.mockImplementation(async (reference) => {
      if (getFunctionName(reference) === "usage:recordQuestion") throw new Error("QUOTA_EXCEEDED");
      throw new Error("Unexpected mutation after quota exhaustion");
    });

    const response = await POST(request());

    expect(response.status).toBe(402);
    expect(authMocks.fetchAuthQuery).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it.each([404, 503])("fails a private manifest preflight with no charge for HTTP %s", async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status }));

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That jurisdiction is not available for research." });
    expect(fetch).toHaveBeenCalledWith(
      "https://convex.example.test/private/chat-research-manifest",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer user-session-token" }),
        body: JSON.stringify({ jurisdictionId: selectedJurisdictionId }),
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });

  it("rejects malformed private manifest data instead of accepting forged stores", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({
      ...manifest,
      stores: [{ ...manifest.stores[0], relation: "geographic_ancestor" }],
    }));

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat streamed governed interaction", () => {
  it("answers an exact greeting in on mode without Jev or Gemini", async () => {
    process.env.CHAT_INTENT_ROUTING_MODE = "on";
    const result = await events(await POST(request({ query: "Hello!!" })));
    expect(result.at(-1)).toMatchObject({
      type: "done", result: CHAT_POLICY_RESPONSES.courtesy, answerKind: "policy", citations: [],
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(authMocks.getToken).not.toHaveBeenCalled();
    expect(interactionMocks.create).not.toHaveBeenCalled();
    expect(mutationNames()).toEqual(["usage:recordQuestion", "chats:completeGovernedInteraction"]);
    expect(authMocks.fetchAuthMutation.mock.calls.at(-1)?.[1]).toMatchObject({
      model: "app-policy-v1", answerKind: "policy", finalAnswer: CHAT_POLICY_RESPONSES.courtesy,
      authorizedScopeSize: 0, readyStoreCount: 0, jurisdictionCoverage: [],
    });
  });

  it("uses a high-probability Jev refusal without Gemini", async () => {
    process.env.CHAT_INTENT_ROUTING_MODE = "on";
    process.env.TYPESAFE_API_KEY = "test-typesafe-key";
    vi.mocked(fetch).mockImplementation(async (input) => String(input).includes("typesafe.ai")
      ? Response.json({ model: "jev-1.13.0", answers: { route: {
        type: "choice", choice: "out_of_scope", confidence: 0.99,
        probabilities: { legal: 0.001, courtesy: 0.001, unclear: 0.001, out_of_scope: 0.997 },
      } } })
      : Response.json(manifest));
    const result = await events(await POST(request({ query: "Tell me a joke" })));
    expect(result.at(-1)).toMatchObject({
      type: "done", result: CHAT_POLICY_RESPONSES.out_of_scope, answerKind: "policy", citations: [],
    });
    expect(interactionMocks.create).not.toHaveBeenCalled();
    expect(authMocks.getToken).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(mutationNames()).toEqual(["usage:recordQuestion", "chats:completeGovernedInteraction"]);
  });

  it("uses a high-probability Jev clarification without Gemini", async () => {
    process.env.CHAT_INTENT_ROUTING_MODE = "on";
    process.env.TYPESAFE_API_KEY = "test-typesafe-key";
    vi.mocked(fetch).mockImplementation(async (input) => String(input).includes("typesafe.ai")
      ? Response.json({ model: "jev-1.13.0", answers: { route: {
        type: "choice", choice: "unclear", confidence: 0.99,
        probabilities: { legal: 0.001, courtesy: 0.001, unclear: 0.997, out_of_scope: 0.001 },
      } } })
      : Response.json(manifest));
    const result = await events(await POST(request({ query: "What should I do about that?" })));
    expect(result.at(-1)).toMatchObject({
      type: "done", result: CHAT_POLICY_RESPONSES.unclear, answerKind: "policy", citations: [],
    });
    expect(interactionMocks.create).not.toHaveBeenCalled();
    expect(authMocks.getToken).not.toHaveBeenCalled();
  });

  it("falls back to legal File Search for a malformed Jev response", async () => {
    process.env.CHAT_INTENT_ROUTING_MODE = "on";
    process.env.TYPESAFE_API_KEY = "test-typesafe-key";
    vi.mocked(fetch).mockImplementation(async (input) => String(input).includes("typesafe.ai")
      ? Response.json({ answers: { route: { type: "choice", choice: "out_of_scope", probabilities: {} } } })
      : Response.json(manifest));
    const result = await events(await POST(request({ query: "Can my landlord evict me?" })));
    expect(result.at(-1)).toMatchObject({ type: "done", answerKind: "legal" });
    expect(interactionMocks.create).toHaveBeenCalledTimes(1);
  });

  it("observes Jev in shadow mode while keeping legal File Search", async () => {
    process.env.CHAT_INTENT_ROUTING_MODE = "shadow";
    process.env.TYPESAFE_API_KEY = "test-typesafe-key";
    vi.mocked(fetch).mockImplementation(async (input) => String(input).includes("typesafe.ai")
      ? Response.json({ model: "jev-1.13.0", answers: { route: {
        type: "choice", choice: "out_of_scope", confidence: 0.99,
        probabilities: { legal: 0.001, courtesy: 0.001, unclear: 0.001, out_of_scope: 0.997 },
      } } })
      : Response.json(manifest));
    const result = await events(await POST(request({ query: "Tell me a joke" })));
    expect(result.at(-1)).toMatchObject({ type: "done", answerKind: "legal" });
    expect(interactionMocks.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("reserves hosting time beyond the application deadline", () => {
    expect(maxDuration).toBeGreaterThan(110);
  });

  it("completes an uncited greeting as a claimed no-evidence answer", async () => {
    interactionMocks.create.mockResolvedValue(successfulStream("Hello!"));
    const final = canonicalInteraction("Hello!");
    final.steps[0].content[0].annotations = [];
    interactionMocks.get.mockResolvedValue(final);
    authMocks.fetchAuthMutation.mockImplementation(async (reference) => {
      if (getFunctionName(reference) === "usage:recordQuestion") return {};
      return { status: "completed", outcome: "success", answerKind: "legal", citations: [], partialCoverage: false,
        citationClaim, expiresAt: Date.now() + 60_000 };
    });
    const result = await events(await POST(request({ query: "hello" })));
    expect(result[0]).toEqual({ type: "delta", text: "I couldn't find enough supporting material in this jurisdiction's library to answer. Try asking a more specific legal question." });
    expect(JSON.stringify(result)).not.toContain("Hello!");
    expect(result.at(-1)).toMatchObject({ type: "done", citations: [], citationClaim,
      result: "I couldn't find enough supporting material in this jurisdiction's library to answer. Try asking a more specific legal question." });
  });

  it("closes at the application deadline even when the canonical read ignores cancellation", async () => {
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    interactionMocks.get.mockImplementation(() => new Promise(() => undefined));
    const resultPromise = events(await POST(request()));
    await vi.advanceTimersByTimeAsync(110_000);
    expect((await resultPromise).at(-1)?.type).toBe("error");
    const summary = JSON.parse(errorLog.mock.calls.at(-1)![1]);
    expect(summary).toMatchObject({ phase: "canonical_read", category: "timeout", execution: {
      modelDeadlineReached: false, terminalDeadlineReached: true, clientAbortObserved: false,
      completionEventAccepted: true, streamClosed: true,
    } });
  });

  it("records the terminal deadline guard when proof work crosses the limit before the timer callback", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-10-04T08:00:00.000Z").getTime();
    vi.setSystemTime(startedAt);
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "sign").mockImplementationOnce(async (...args) => {
      const proof = await sign(...args);
      // A clock jump advances the deadline guard without dispatching timer callbacks.
      vi.setSystemTime(startedAt + 110_000);
      return proof;
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const streamEvents = await events(await POST(request()));
    expect(streamEvents).toEqual([{ type: "error", reason: "deadline_exceeded",
      error: "This answer took too long and could not be verified. You can ask a more focused question or try again later." }]);
    expect(JSON.parse(errorLog.mock.calls.at(-1)![1])).toMatchObject({ phase: "completion", execution: {
      modelDeadlineReached: false, terminalDeadlineReached: true, clientAbortObserved: false,
      providerFailure: "none", completionEventAccepted: true, streamClosed: true,
    } });
    expect(mutationNames()).toEqual(["usage:recordQuestion"]);
  });

  it("uses one selected-first File Search interaction and authorizes before any answer text", async () => {
    let finishTerminal!: (value: unknown) => void;
    const terminal = new Promise((resolve) => { finishTerminal = resolve; });
    authMocks.fetchAuthMutation.mockImplementation(async (reference) => {
      const name = getFunctionName(reference);
      if (name === "usage:recordQuestion") return { used: 1, limit: 10, isPro: false };
      if (name === "chats:completeGovernedInteraction") return await terminal;
      throw new Error(`Unexpected mutation: ${name}`);
    });

    const response = await POST(request());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let firstReadResolved = false;
    const firstRead = reader.read().then(value => { firstReadResolved = true; return value; });
    await vi.waitFor(() => {
      expect(interactionMocks.get).toHaveBeenCalledTimes(1);
      expect(mutationNames()).toEqual(["usage:recordQuestion", "chats:completeGovernedInteraction"]);
    });
    expect(firstReadResolved).toBe(false);
    expect(interactionMocks.create).toHaveBeenCalledTimes(1);
    expect(interactionMocks.create.mock.calls[0][0]).toMatchObject({
      model: "gemini-test-model",
      stream: true,
      tools: [{ type: "file_search", file_search_store_names: ["fileSearchStores/ghana"] }],
    });

    finishTerminal({
      status: "completed",
      outcome: "success",
      answerKind: "legal",
      citations: [publicCitation],
      partialCoverage: false,
      citationClaim,
      expiresAt: Date.now() + 60_000,
    });
    const first = JSON.parse(decoder.decode((await firstRead).value).trim());
    expect(first).toEqual({ type: "delta", text: "Employees are protected." });
    const terminalEvent = JSON.parse(decoder.decode((await reader.read()).value).trim());
    expect(terminalEvent).toEqual({
      type: "done",
      result: "Employees are protected.",
      answerKind: "legal",
      citations: [publicCitation],
      citationClaim,
      partialCoverage: false,
    });
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("passes only the exact request history and server manifest to Gemini", async () => {
    const history = [
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
    ];

    await events(await POST(request({ messages: history })));

    const providerInput = JSON.parse(interactionMocks.create.mock.calls[0][0].input.text);
    expect(providerInput).toEqual({
      untrustedQuestion: "What protection applies?",
      conversation: history,
    });
    expect(JSON.stringify(interactionMocks.create.mock.calls[0][0])).not.toContain("user-session-token");
  });

  it("preserves the legacy ten-turn provider context when newer clients submit twenty turns", async () => {
    const history = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `Earlier turn ${index}` }));
    await events(await POST(request({ messages: history, historyComplete: true })));
    const providerInput = JSON.parse(interactionMocks.create.mock.calls[0][0].input.text);
    expect(providerInput.conversation).toEqual(history.slice(-10));
  });

  it("binds canonical citations and server-derived scope metadata in the terminal mutation", async () => {
    await events(await POST(request()));

    const terminalArgs = authMocks.fetchAuthMutation.mock.calls.find(
      ([reference]) => getFunctionName(reference) === "chats:completeGovernedInteraction",
    )?.[1];
    expect(terminalArgs).toMatchObject({
      routeNonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      externalId: "chat-external-id",
      jurisdictionId: selectedJurisdictionId,
      assistantClientId: "assistant-client-id",
      finalAnswer: "Employees are protected.",
      citations: [{
        jurisdictionId: selectedJurisdictionId,
        resourceId: selectedResourceId,
        versionId: selectedVersionId,
        providerStoreName: selectedStoreName,
        pageNumber: 12,
      }],
      model: "gemini-test-model",
      elapsedMs: expect.any(Number),
      outcome: "success",
      authorizedScopeSize: 1,
      readyStoreCount: 1,
      partialCoverage: false,
      jurisdictionCoverage: [{ ordinal: 0, relation: "selected", coverage: "evidence" }],
      serviceProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(terminalArgs).not.toHaveProperty("error");
  });

  it("requires authoritative catalog approval of an exact document URI", async () => {
    const documentName = "fileSearchStores/ghana/documents/wrong-document";
    const canonical = canonicalInteraction();
    canonical.steps[0].content[0].annotations[0].document_uri = documentName;
    interactionMocks.get.mockResolvedValue(canonical);
    authMocks.fetchAuthMutation.mockImplementation(async (reference, args) => {
      if (getFunctionName(reference) === "usage:recordQuestion") return { used: 1, limit: 10, isPro: false };
      if (args.outcome === "success") {
        expect(args.citations[0]).toMatchObject({ providerStoreName: selectedStoreName, providerDocumentName: documentName });
        throw new Error("INVALID_CHAT_CITATIONS");
      }
      return { status: "completed", outcome: "failure" };
    });

    const streamEvents = await events(await POST(request()));

    expect(streamEvents.at(-1)).toEqual({
      type: "error",
      error: "We couldn't process your request. Please try again.",
    });
    expect(streamEvents.some((event) => event.type === "done")).toBe(false);
    expect(streamEvents.some((event) => event.type === "delta")).toBe(false);
    expect(JSON.stringify(streamEvents)).not.toContain(documentName);
  });

  it("rejects a result without a selected-store citation and emits no done", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({
      authorizedScopeSize: 2,
      stores: [
        manifest.stores[0],
        {
          jurisdictionId: "parent-jurisdiction-id",
          name: "West Africa",
          kind: "geographic",
          relation: "geographic_ancestor",
          storeName: "fileSearchStores/west-africa",
        },
      ],
      partialCoverage: false,
    }));
    interactionMocks.get.mockResolvedValue(canonicalInteraction(
      "Employees are protected.",
      "parent-jurisdiction-id",
    ));

    const streamEvents = await events(await POST(request()));

    expect(streamEvents.at(-1)).toEqual({
      type: "error",
      error: "We couldn't process your request. Please try again.",
    });
    expect(streamEvents.some((event) => event.type === "done")).toBe(false);
    const failure = authMocks.fetchAuthMutation.mock.calls.find(
      ([reference, args]) => getFunctionName(reference) === "chats:completeGovernedInteraction" && args.outcome === "failure",
    )?.[1];
    expect(failure).toMatchObject({ failureCategory: "validation", citations: [] });
    expect(failure).not.toHaveProperty("finalAnswer");
  });

  it("never emits a raw Gemini error or done after provider failure", async () => {
    const rawSecret = "provider-key-and-file-search-store-secret";
    interactionMocks.create.mockRejectedValue(Object.assign(new Error(rawSecret), { status: 403 }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const streamEvents = await events(await POST(request()));

    expect(streamEvents).toEqual([{
      type: "error",
      error: "We couldn't process your request. Please try again.",
    }]);
    expect(JSON.stringify(streamEvents)).not.toContain(rawSecret);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(rawSecret);
    expect(errorLog).toHaveBeenCalledWith("chat_request_failed", expect.any(String));
    expect(JSON.parse(errorLog.mock.calls.at(-1)![1])).toMatchObject({
      phase: "generation", category: "authentication", elapsedMs: expect.any(Number),
    });
    expect(streamEvents.some((event) => event.type === "done")).toBe(false);
    const terminalArgs = authMocks.fetchAuthMutation.mock.calls.at(-1)?.[1];
    expect(terminalArgs).toMatchObject({
      outcome: "failure",
      failureCategory: "authentication",
      citations: [],
      jurisdictionCoverage: [{ ordinal: 0, relation: "selected", coverage: "no_evidence" }],
    });
    expect(terminalArgs).not.toHaveProperty("error");
    expect(terminalArgs).not.toHaveProperty("finalAnswer");
  });

  it("treats replayed terminal completion as no new done event", async () => {
    authMocks.fetchAuthMutation.mockImplementation(async (reference) => {
      const name = getFunctionName(reference);
      if (name === "usage:recordQuestion") return { used: 1, limit: 10, isPro: false };
      return { status: "replayed", outcome: "success" };
    });

    const streamEvents = await events(await POST(request()));

    expect(streamEvents.some((event) => event.type === "done")).toBe(false);
    expect(streamEvents.at(-1)).toEqual({
      type: "error",
      error: "We couldn't process your request. Please try again.",
    });
  });

  it.each([8, 14, 16])("records the 90-second cutoff after %s searches without confusing it with search exhaustion", async (searches) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
    let providerSignal: AbortSignal | undefined;
    interactionMocks.create.mockImplementation(async (_input, options) => {
      providerSignal = options.signal;
      return (async function* () {
        yield {
          event_type: "interaction.created",
          interaction: { id: "interaction-timeout", status: "in_progress" },
        };
        for (let index = 0; index < searches; index += 1) {
          yield { event_type: "step.start", interaction_id: "interaction-timeout", index: index * 2,
            step: { type: "file_search_call", id: `search-${index}` } };
          yield { event_type: "step.stop", interaction_id: "interaction-timeout", index: index * 2 };
          yield { event_type: "step.start", interaction_id: "interaction-timeout", index: index * 2 + 1,
            step: { type: "file_search_result", call_id: `search-${index}` } };
          yield { event_type: "step.stop", interaction_id: "interaction-timeout", index: index * 2 + 1 };
        }
        await new Promise<never>((_, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
        });
      })();
    });

    const responsePromise = POST(request());
    await vi.advanceTimersByTimeAsync(90_000);
    const streamEvents = await events(await responsePromise);

    expect(providerSignal?.aborted).toBe(true);
    expect(streamEvents.some((event) => event.type === "done")).toBe(false);
    expect(streamEvents.at(-1)).toEqual({
      type: "error",
      reason: "deadline_exceeded",
      error: "This answer took too long and could not be verified. You can ask a more focused question or try again later.",
    });
    const terminalArgs = authMocks.fetchAuthMutation.mock.calls.at(-1)?.[1];
    expect(terminalArgs).toMatchObject({
      outcome: "failure",
      failureCategory: "timeout",
      elapsedMs: 90_000,
      diagnostics: {
        phase: "generation", reason: "deadline_exceeded",
        searchCallCount: searches, searchResultCount: searches,
        canonicalReadCompleted: false,
        execution: { modelDeadlineReached: true, terminalDeadlineReached: false,
          clientAbortObserved: false, streamAbortObserved: true, providerFailure: "none",
          completionEventAccepted: false, streamClosed: false, resumeAttempted: false },
      },
    });
  });

  it.each((["create", "iterator", "completion_eof", "resume"] as const).flatMap(
    boundary => (["resolve", "reject"] as const).map(lateOutcome => ({ boundary, lateOutcome })),
  ))("releases the 90-second waiter when $boundary ignores abort, despite late $lateOutcome", async ({ boundary, lateOutcome }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let resolveProvider!: (value: ReturnType<typeof successfulStream>) => void;
    let rejectProvider!: (reason: Error) => void;
    const pending = new Promise<ReturnType<typeof successfulStream>>((resolve, reject) => {
      resolveProvider = resolve;
      rejectProvider = reject;
    });
    let released = false;
    if (boundary === "create") {
      interactionMocks.create.mockReturnValue(pending);
    } else if (boundary === "resume") {
      interactionMocks.create.mockResolvedValue((async function* () {
        yield { event_type: "interaction.created", event_id: "synthetic-resume-cursor",
          interaction: { id: "interaction-1", status: "in_progress" } };
      })());
      interactionMocks.get.mockReturnValue(pending);
    } else {
      interactionMocks.create.mockResolvedValue((async function* () {
        const stream = successfulStream();
        if (boundary === "completion_eof") {
          yield* stream;
          await pending;
        } else {
          const first = await stream.next();
          if (!first.done) yield first.value;
          await pending;
          yield* stream;
        }
      })());
    }
    const reader = (await POST(request())).body!.getReader();
    let firstReadSettled = false;
    const firstRead = reader.read().then(value => { firstReadSettled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(89_999);
      expect(firstReadSettled).toBe(false);
      expect(interactionMocks.create).toHaveBeenCalledTimes(1);
      expect(interactionMocks.get).toHaveBeenCalledTimes(boundary === "resume" ? 1 : 0);
      await vi.advanceTimersByTimeAsync(1);
      // Check settlement before awaiting, so the regression fails at 90s rather
      // than quietly advancing to the independent 110s terminal deadline.
      expect(firstReadSettled).toBe(true);
      const first = await firstRead;
      expect(JSON.parse(new TextDecoder().decode(first.value).trim())).toEqual({
        type: "error", reason: "deadline_exceeded",
        error: "This answer took too long and could not be verified. You can ask a more focused question or try again later.",
      });
      await expect(reader.read()).resolves.toMatchObject({ done: true });
      const completedCalls = authMocks.fetchAuthMutation.mock.calls.filter(
        ([reference]) => getFunctionName(reference) === "chats:completeGovernedInteraction",
      );
      expect(completedCalls).toHaveLength(1);
      expect(completedCalls[0][1]).toMatchObject({
        outcome: "failure", failureCategory: "timeout", elapsedMs: 90_000,
        diagnostics: { phase: "generation", reason: "deadline_exceeded", canonicalReadCompleted: false,
          execution: { modelDeadlineReached: true, terminalDeadlineReached: false,
            clientAbortObserved: false, streamAbortObserved: true, providerFailure: "none",
            completionEventAccepted: boundary === "completion_eof", streamClosed: false,
            resumeAttempted: boundary === "resume",
            resumeOutcome: boundary === "resume" ? "pending" : "not_attempted" } },
      });
      const frozenFailure = JSON.stringify(completedCalls[0][1]);
      released = true;
      if (lateOutcome === "resolve") resolveProvider(successfulStream());
      else rejectProvider(new Error("synthetic late provider rejection"));
      await vi.advanceTimersByTimeAsync(0);
      expect(interactionMocks.create).toHaveBeenCalledTimes(1);
      expect(interactionMocks.get).toHaveBeenCalledTimes(boundary === "resume" ? 1 : 0);
      expect(authMocks.fetchAuthMutation.mock.calls.filter(
        ([reference]) => getFunctionName(reference) === "chats:completeGovernedInteraction",
      )).toHaveLength(1);
      expect(JSON.stringify(completedCalls[0][1])).toBe(frozenFailure);
      await expect(reader.read()).resolves.toMatchObject({ done: true });
    } finally {
      if (!released) rejectProvider(new Error("synthetic regression cleanup"));
      await vi.advanceTimersByTimeAsync(20_000);
      await reader.cancel();
    }
  });

  it("includes preparation time in the original 90-second generation waiter", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-09-04T00:00:00.000Z").getTime();
    vi.setSystemTime(startedAt);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    authMocks.isAuthenticated.mockImplementationOnce(() => new Promise(resolve => {
      setTimeout(() => resolve(true), 30_000);
    }));
    interactionMocks.create.mockImplementation(() => new Promise(() => undefined));
    const response = POST(request());
    await vi.advanceTimersByTimeAsync(30_000);
    const reader = (await response).body!.getReader();
    let firstReadSettled = false;
    const firstRead = reader.read().then(value => { firstReadSettled = true; return value; });
    try {
      expect(Date.now() - startedAt).toBe(30_000);
      expect(interactionMocks.create).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(firstReadSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(firstReadSettled).toBe(true);
      expect(JSON.parse(new TextDecoder().decode((await firstRead).value).trim())).toMatchObject({
        type: "error", reason: "deadline_exceeded",
      });
      await expect(reader.read()).resolves.toMatchObject({ done: true });
      expect(authMocks.fetchAuthMutation.mock.calls.at(-1)?.[1]).toMatchObject({
        outcome: "failure", failureCategory: "timeout", elapsedMs: 90_000,
        diagnostics: { execution: { modelDeadlineReached: true, terminalDeadlineReached: false } },
      });
      expect(interactionMocks.get).not.toHaveBeenCalled();
    } finally {
      await vi.advanceTimersByTimeAsync(20_000);
      await reader.cancel();
    }
  });

  it("uses the terminal reserve for the canonical read after the stream completes near 90 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
    let streamSignal: AbortSignal | undefined;
    let canonicalSignal: AbortSignal | undefined;
    interactionMocks.create.mockImplementation(async (_input, options) => {
      streamSignal = options.signal;
      return (async function* () {
        await new Promise((resolve) => setTimeout(resolve, 89_900));
        for await (const event of successfulStream()) yield event;
      })();
    });
    interactionMocks.get.mockImplementation(async (_id, _params, options) => {
      canonicalSignal = options.signal;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(canonicalInteraction()), 1_100);
        options.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("canonical read aborted"));
        }, { once: true });
      });
    });

    const response = await POST(request());
    const streamEventsPromise = events(response);
    await vi.advanceTimersByTimeAsync(91_000);
    const streamEvents = await streamEventsPromise;

    expect(streamSignal?.aborted).toBe(false);
    expect(canonicalSignal).not.toBe(streamSignal);
    expect(canonicalSignal?.aborted).toBe(false);
    expect(streamEvents.at(-1)?.type).toBe("done");
  });

  it("emits no answer text when terminal validation exhausts the shared 110-second deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
    authMocks.fetchAuthMutation.mockImplementation(async (reference) => {
      const name = getFunctionName(reference);
      if (name === "usage:recordQuestion") return { used: 1, limit: 10, isPro: false };
      return await new Promise<never>(() => undefined);
    });

    const response = await POST(request());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let firstReadResolved = false;
    const firstRead = reader.read().then(value => { firstReadResolved = true; return value; });
    await vi.waitFor(() => {
      expect(mutationNames()).toEqual(["usage:recordQuestion", "chats:completeGovernedInteraction"]);
    });
    expect(firstReadResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(110_000);
    const terminalEvent = JSON.parse(decoder.decode((await firstRead).value).trim());

    expect(terminalEvent).toEqual({
      type: "error",
      reason: "deadline_exceeded",
      error: "This answer took too long and could not be verified. You can ask a more focused question or try again later.",
    });
    expect(mutationNames()).toEqual(["usage:recordQuestion", "chats:completeGovernedInteraction"]);
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("records an aborted outcome and closes without done when the client disconnects", async () => {
    const abort = new AbortController();
    interactionMocks.create.mockImplementation(async (_input, options) => (async function* () {
      yield {
        event_type: "interaction.created",
        interaction: { id: "interaction-abort", status: "in_progress" },
      };
      await new Promise<never>((_, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
      });
    })());

    const response = await POST(request({}, { signal: abort.signal }));
    abort.abort();
    const streamEvents = await events(response);

    expect(streamEvents.some((event) => event.type === "done")).toBe(false);
    expect(streamEvents.some((event) => event.type === "error")).toBe(false);
    expect(authMocks.fetchAuthMutation.mock.calls.at(-1)?.[1]).toMatchObject({
      outcome: "aborted",
      citations: [],
      diagnostics: { reason: "aborted", execution: { clientAbortObserved: true,
        modelDeadlineReached: false, terminalDeadlineReached: false, streamAbortObserved: true } },
    });
  });
});
