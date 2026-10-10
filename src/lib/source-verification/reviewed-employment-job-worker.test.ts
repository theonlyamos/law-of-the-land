// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { reviewedEmploymentJobProofParts, reviewedEmploymentSourceBundleCanonicalJson, type ReviewedEmploymentJobWorkerInput } from "../../../shared/reviewed-employment-jobs";
import { verifyTelemetryServiceProof } from "../../../convex/lib/telemetryProof";
import { selectEmploymentEvidence } from "./employment-evidence";
import { PILOT_CATALOG, PILOT_IDENTITY } from "./reviewed-source-cases";
import { PRODUCTION_REVIEWED_EMPLOYMENT_POLICY, REVIEWED_EMPLOYMENT_POLICY, type ReviewedEmploymentPolicy } from "../../../shared/reviewed-employment-policy";
import { caseInput } from "./test-fixtures/reviewed-request-catalog";
import { authoredStage, FAKE_CREDENTIAL } from "./test-fixtures/reviewed-answer-fixtures";
import type { StageRequest } from "./split-verification/contracts";
import * as module from "./reviewed-employment-job-worker";
import { createPublicationFilterBinding } from "../../../shared/gemini-publication-filter";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type Reply = { status: "ok" | "ignored"; payload: string | null };
const ok = (value: unknown = null): Reply => ({ status: "ok", payload: value === null ? null : JSON.stringify(value) });
function stream(value: unknown) {
  const rows = [
    { event_type: "interaction.created", interaction: { model: "gemini-3.8-flash", object: "interaction" } },
    { event_type: "step.start", index: 0, step: { type: "model_output", content: [] } },
    { event_type: "step.delta", index: 0, delta: { type: "text", text: JSON.stringify(value) } },
    { event_type: "step.stop", index: 0 },
    { event_type: "interaction.completed", interaction: { status: "completed", usage: { total_input_tokens: 10,
      total_output_tokens: 20, total_thought_tokens: 30, total_cached_tokens: 0, total_tool_use_tokens: 0, total_tokens: 60 } } },
  ];
  return new Response(rows.map(row => `event: ${row.event_type}\ndata: ${JSON.stringify(row)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}
function fixture(age = 0, policy: ReviewedEmploymentPolicy = REVIEWED_EMPLOYMENT_POLICY, policyId?: string) {
  const input = caseInput("nine-month-control");
  const selection = selectEmploymentEvidence({ question: input.question, history: [], attachments: [] });
  if (selection.status !== "selected") throw new Error("missing selection");
  const submission = { query: selection.question, messages: [], historyComplete: true, selection, facts: selection.facts,
    attachmentIds: ["new-file"], contextAttachmentIds: ["old-file", "new-file"], routeNonce: "n".repeat(43) };
  const createdAt = Date.now() - age;
  const claim = { jobId: "job-fixture", submission: JSON.stringify(submission), createdAt,
    verificationDeadlineAt: createdAt + 240_000, terminalDeadlineAt: createdAt + 270_000,
    externalId: "chat-fixture", jurisdictionId: policy.jurisdictionId, userClientId: "user-fixture", assistantClientId: "answer-fixture",
    ...(policyId ? { policyId } : {}) };
  const source = { status: "authorized", externalId: claim.externalId, jurisdictionId: policy.jurisdictionId,
    resourceId: policy.resourceId, versionId: policy.versionId, sha256: PILOT_IDENTITY.originalSha256,
    byteSize: PILOT_IDENTITY.originalByteLength, asOfDate: new Date().toISOString().slice(0, 10),
    resourceEffectiveDate: null, resourceRepealDate: null, versionEffectiveDate: null, versionRepealDate: null };
  const bundle = { source, manifest: { authorizedScopeSize: 1, partialCoverage: false,
    stores: [{ jurisdictionId: policy.jurisdictionId, name: "Ghana", kind: "geographic", relation: "selected", storeName: "fileSearchStores/fixture" }] } };
  const events: string[] = [], operations: ReviewedEmploymentJobWorkerInput[] = [], wires: { stage: string; body: string }[] = [];
  let claimed = false;
  const rpc = vi.fn(async (request: ReviewedEmploymentJobWorkerInput): Promise<Reply> => {
    operations.push(request); const body = JSON.parse(request.body); events.push(`${request.operation}:${body.stage ?? ""}`);
    if (request.operation === "claim") { if (claimed) return { status: "ignored", payload: null }; claimed = true; return ok(claim); }
    if (request.operation === "authority") return ok(bundle);
    if (request.operation === "state") return ok({ status: "running" });
    if (request.operation === "commit") return ok({ status: "completed", outcome: "success", answerKind: "legal", persisted: true,
      citationClaim: "c".repeat(43), expiresAt: Date.now() + 60_000, partialCoverage: false,
      citations: body.completion.citations.map((citation: { pageNumber: number }) => ({ label: `Labour Act, page ${citation.pageNumber}`,
        jurisdictionId: policy.jurisdictionId, jurisdictionName: "Ghana", jurisdictionKind: "geographic", relation: "selected" })) });
    return ok();
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = String(init!.body), wire = JSON.parse(body);
    const stage = wire.stream ? /Fixed stage: (inventory|consent|overtime)\./.exec(wire.system_instruction)![1] : "draft";
    events.push(`post:${stage}`); wires.push({ stage, body });
    if (stage === "draft") return Response.json({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ candidate: input.candidate }) }] }] });
    return stream(authoredStage({ stage, data: JSON.parse(wire.input) } as StageRequest));
  });
  const run = () => module.createReviewedEmploymentJobWorker({ rpc, fetch,
    credential: FAKE_CREDENTIAL, workerId: "worker-fixture", pollIntervalMs: 10, catalog: policy,
    policyId: policy === PRODUCTION_REVIEWED_EMPLOYMENT_POLICY ? "act651-s55-prod-v1" : "act651-s55-dev-v1" }).run(claim.jobId);
  return { run, rpc, fetch, operations, wires, events, claim, bundle, submission, input };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("supplies the original reviewed allowlist binding in its final signed completion", async () => {
  const f = fixture();
  Object.assign(f.bundle.manifest.stores[0], { publicationFilter: { protocol: "published-v1", environment: "test",
    documents: [{ resourceId: PILOT_CATALOG.resourceId, versionId: PILOT_CATALOG.versionId, sha256: PILOT_IDENTITY.originalSha256 }] } });
  const expectedBinding = await createPublicationFilterBinding(f.bundle.manifest.stores);
  await f.run();
  const commit = JSON.parse(f.operations.find(operation => operation.operation === "commit")!.body);
  expect(commit.completion.publicationFilterBinding).toBe(expectedBinding);
  expect(f.wires.map(wire => wire.stage).sort()).toEqual(["consent", "draft", "inventory", "overtime"]);
});

it("runs all four stages against the pinned production edition and saves its exact citation provenance", async () => {
  const f = fixture(0, PRODUCTION_REVIEWED_EMPLOYMENT_POLICY, "act651-s55-prod-v1"); await f.run();
  expect(f.fetch).toHaveBeenCalledTimes(4);
  const commit = JSON.parse(f.operations.find(o => o.operation === "commit")!.body);
  for (const operation of f.operations) expect(operation.publicationFilterProtocol).toBe("published-v1");
  expect(commit.completion.publicationFilterProtocol).toBe("published-v1");
  expect(commit.source).toMatchObject(PRODUCTION_REVIEWED_EMPLOYMENT_POLICY);
  expect(commit.completion.citations.every((c: Record<string, unknown>) => c.resourceId === PRODUCTION_REVIEWED_EMPLOYMENT_POLICY.resourceId
    && c.versionId === PRODUCTION_REVIEWED_EMPLOYMENT_POLICY.versionId)).toBe(true);
});
it.each([undefined, "act651-s55-dev-v1"])("rejects a production claim with policy ID %s before authority or dispatch", async policyId => {
  const f = fixture(0, PRODUCTION_REVIEWED_EMPLOYMENT_POLICY, policyId); await f.run();
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.operations.some(o => o.operation === "authority" || o.operation === "commit")).toBe(false);
});

it("runs the unchanged draft and both audits only after exact persisted reservations, then commits immutable IDs and provenance", async () => {
  const f = fixture(); await f.run();
  expect(f.wires.map(w => w.stage).sort()).toEqual(["consent", "draft", "inventory", "overtime"]);
  for (const wire of f.wires) {
    const reserved = f.operations.find(o => o.operation === "reserve" && JSON.parse(o.body).stage === wire.stage)!;
    expect(JSON.parse(reserved.body)).toEqual({ stage: wire.stage, requestSha256: sha(wire.body),
      candidateSha256: wire.stage === "draft" ? null : sha(f.input.candidate), sourceBinding: sha(reviewedEmploymentSourceBundleCanonicalJson(f.bundle)) });
    expect(f.events.indexOf(`reserve:${wire.stage}`)).toBeLessThan(f.events.indexOf(`post:${wire.stage}`));
    const passed = f.operations.find(o => o.operation === "passed" && JSON.parse(o.body).stage === wire.stage)!;
    expect(JSON.parse(passed.body)).toEqual({ ...JSON.parse(reserved.body), candidateSha256: sha(f.input.candidate) });
    if (wire.stage !== "draft") expect(JSON.parse(wire.body).generation_config).toMatchObject({ max_output_tokens: 8192,
      thinking_level: wire.stage === "inventory" ? "low" : "medium" });
  }
  expect(f.events.indexOf("passed:inventory")).toBeLessThan(f.events.indexOf("reserve:consent"));
  expect(f.events.indexOf("passed:inventory")).toBeLessThan(f.events.indexOf("reserve:overtime"));
  const commit = JSON.parse(f.operations.find(o => o.operation === "commit")!.body);
  expect(Object.keys(commit).sort()).toEqual(["completion", "source", "user"]);
  expect(commit.completion).toMatchObject({ externalId: "chat-fixture", assistantClientId: "answer-fixture", finalAnswer: f.input.candidate,
    routeNonce: f.submission.routeNonce, answerKind: "legal", outcome: "success", attachmentIds: ["old-file", "new-file"],
    model: "gemini-3.8-flash", authorizedScopeSize: 1, readyStoreCount: 1, partialCoverage: false,
    jurisdictionCoverage: [{ ordinal: 0, relation: "selected", coverage: "evidence" }] });
  expect(commit.user).toEqual({ clientId: "user-fixture", content: f.submission.query, attachmentIds: ["new-file"] });
  expect(commit.source).toMatchObject({ expectedSha256: PILOT_IDENTITY.originalSha256, expectedByteSize: PILOT_IDENTITY.originalByteLength });
  expect(commit.completion.citations.every((c: Record<string, unknown>) => c.resourceId === PILOT_CATALOG.resourceId
    && c.versionId === PILOT_CATALOG.versionId && c.providerStoreName === "fileSearchStores/fixture" && typeof c.pageNumber === "number")).toBe(true);
  expect(JSON.stringify(f.operations)).not.toContain(FAKE_CREDENTIAL);
  expect(JSON.stringify(f.operations)).not.toMatch(/Bearer|accessToken|browserJWT/);
});
it("duplicate deliveries produce no additional provider calls or commit", async () => {
  const f = fixture(); await Promise.all([f.run(), f.run()]);
  expect(f.fetch).toHaveBeenCalledTimes(4); expect(f.operations.filter(o => o.operation === "commit")).toHaveLength(1);
});
it.each(["denied", "uncertain"])("does not dispatch or retry after a %s reservation", async mode => {
  const f = fixture(), original = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async input => input.operation === "reserve"
    ? mode === "denied" ? { status: "ignored", payload: null } : Promise.reject(new Error("uncertain dispatch")) : original(input));
  await f.run(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.operations.filter(o => o.operation === "commit")).toHaveLength(0);
  expect(f.rpc.mock.calls.filter(([o]) => o.operation === "reserve")).toHaveLength(1);
  expect(f.rpc.mock.calls.filter(([o]) => o.operation === "fail")).toHaveLength(1);
});
it("never dispatches after a pending reservation resolves following persisted cancellation", async () => {
  const f = fixture(), original = f.rpc.getMockImplementation()!;
  let release!: (value: Reply) => void, reserveStarted!: () => void;
  const started = new Promise<void>(resolve => { reserveStarted = resolve; });
  f.rpc.mockImplementation(async input => {
    if (input.operation === "reserve") { reserveStarted(); return new Promise(resolve => { release = resolve; }); }
    if (input.operation === "state") return { status: "ignored", payload: null };
    return original(input);
  });
  const pending = f.run(); await started; await pending; release(ok()); await Promise.resolve();
  expect(f.fetch).not.toHaveBeenCalled(); expect(f.operations.filter(o => o.operation === "commit")).toHaveLength(0);
});
it("counts queue delay against the original draft budget", async () => {
  const f = fixture(60_001); await f.run(); expect(f.fetch).not.toHaveBeenCalled();
  expect(f.operations.find(o => o.operation === "fail")?.body).toBe(JSON.stringify({ reason: "deadline_exceeded" }));
});
it("withholds when fresh native authority drifts before verification", async () => {
  const f = fixture(), original = f.rpc.getMockImplementation()!; let reads = 0;
  f.rpc.mockImplementation(input => input.operation === "authority" && ++reads > 1
    ? Promise.resolve(ok({ ...f.bundle, manifest: { ...f.bundle.manifest, stores: [{ ...f.bundle.manifest.stores[0], name: "Changed" }] } })) : original(input));
  await f.run(); expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.operations.filter(o => o.operation === "commit")).toHaveLength(0);
});
it("does not pass a malformed inventory or dispatch either audit", async () => {
  const f = fixture(), original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation((url, init) => JSON.parse(String(init!.body)).stream ? Promise.resolve(stream({ stage: "inventory", decision: "pass", segments: [] })) : original(url, init));
  await f.run(); expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.operations.filter(o => o.operation === "passed").map(o => JSON.parse(o.body).stage)).toEqual(["draft"]);
  expect(f.operations.filter(o => o.operation === "commit")).toHaveLength(0);
});
it("rolls back a failed commit and records one closed failure without retry", async () => {
  const f = fixture(), original = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(input => input.operation === "commit" ? Promise.reject(new Error("private backend detail")) : original(input));
  await f.run(); expect(f.fetch).toHaveBeenCalledTimes(4);
  expect(f.rpc.mock.calls.filter(([o]) => o.operation === "commit")).toHaveLength(1);
  expect(f.operations.filter(o => o.operation === "fail").map(o => JSON.parse(o.body))).toEqual([{ reason: "commit_failed" }]);
});
it("an expired saved job never obtains authority or dispatches a provider request", async () => {
  const f = fixture(270_001); await f.run();
  expect(f.fetch).not.toHaveBeenCalled(); expect(f.operations.some(o => o.operation === "authority")).toBe(false);
  expect(f.operations.filter(o => o.operation === "fail").map(o => JSON.parse(o.body))).toEqual([{ reason: "deadline_exceeded" }]);
});
it("withholds after final authority drifts even when both audits passed", async () => {
  const f = fixture(), original = f.rpc.getMockImplementation()!; let reads = 0;
  f.rpc.mockImplementation(input => input.operation === "authority" && ++reads > 2
    ? Promise.resolve(ok({ ...f.bundle, source: { ...f.bundle.source, resourceEffectiveDate: "2003-01-01" } })) : original(input));
  await f.run(); expect(f.fetch).toHaveBeenCalledTimes(4);
  expect(f.operations.filter(o => o.operation === "passed")).toHaveLength(4);
  expect(f.operations.filter(o => o.operation === "commit")).toHaveLength(0);
});
it("does not dispatch either audit when inventory pass persistence is uncertain", async () => {
  const f = fixture(), original = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(input => input.operation === "passed" && JSON.parse(input.body).stage === "inventory"
    ? Promise.reject(new Error("unknown persistence")) : original(input));
  await f.run(); expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.rpc.mock.calls.filter(([o]) => o.operation === "passed" && JSON.parse(o.body).stage === "inventory")).toHaveLength(1);
  expect(f.operations.filter(o => o.operation === "commit")).toHaveLength(0);
});
it("never commits a partially failed audit or retries its dispatch", async () => {
  const f = fixture(), original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation((url, init) => String(JSON.parse(String(init!.body)).system_instruction).includes("Fixed stage: consent.")
    ? Promise.resolve(stream({ stage: "consent", decision: "withhold", partition: "rejected", claims: [] })) : original(url, init));
  await f.run(); expect(f.rpc.mock.calls.filter(([o]) => o.operation === "reserve" && JSON.parse(o.body).stage === "consent")).toHaveLength(1);
  expect(f.operations.filter(o => o.operation === "commit")).toHaveLength(0);
});
it.each(["oversized", "credential_echo", "duplicate_json"])("rejects a %s native draft response before persisting a draft pass", async kind => {
  const f = fixture();
  f.fetch.mockImplementation(async () => kind === "oversized" ? new Response("x".repeat(32 * 1024 + 1))
    : kind === "duplicate_json" ? new Response('{"status":"completed","status":"completed","steps":[]}')
    : Response.json({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ candidate: FAKE_CREDENTIAL }) }] }] }));
  await f.run(); expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.operations.some(o => o.operation === "passed" || o.operation === "commit")).toBe(false);
  expect(JSON.stringify(f.operations)).not.toContain(FAKE_CREDENTIAL);
});
it("rejects a stored submission with a browser credential field before any authority call", async () => {
  const f = fixture(); f.claim.submission = JSON.stringify({ ...f.submission, browserJWT: "synthetic-never-persist" });
  await f.run(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.operations.some(o => o.operation === "authority")).toBe(false);
  expect(f.operations.filter(o => o.operation === "fail").map(o => JSON.parse(o.body))).toEqual([{ reason: "invalid_request" }]);
});
it("native runtime is disabled by default before any network call", async () => {
  vi.stubEnv("LOCAL_REVIEWED_EMPLOYMENT_BACKGROUND_ENABLED", undefined);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
  await module.runReviewedEmploymentJob("job-fixture"); expect(fetch).not.toHaveBeenCalled();
});
it("native runtime signs an exact single claim with the existing service proof and never authenticates a browser token", async () => {
  const env = { NODE_ENV: "development", VERCEL: undefined, LOCAL_REVIEWED_EMPLOYMENT_ENABLED: "1",
    LOCAL_REVIEWED_EMPLOYMENT_BACKGROUND_ENABLED: "1", LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED: "1", LOCAL_REVIEWED_EMPLOYMENT_SPLIT_ENABLED: "1",
    CONVEX_DEPLOYMENT: "dev:adventurous-hummingbird-244", NEXT_PUBLIC_CONVEX_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.cloud",
    NEXT_PUBLIC_CONVEX_SITE_URL: "https://adventurous-hummingbird-244.eu-west-1.convex.site", GOOGLE_AI_API_KEY: FAKE_CREDENTIAL,
    TELEMETRY_INGEST_SECRET: "synthetic-only-native-proof-secret-1984" };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const mutation = vi.spyOn(ConvexHttpClient.prototype, "mutation").mockResolvedValue({ status: "ignored", payload: null });
  const setAuth = vi.spyOn(ConvexHttpClient.prototype, "setAuth");
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("native transport forbidden in test"));
  await module.runReviewedEmploymentJob("job-fixture");
  expect(mutation).toHaveBeenCalledTimes(1); expect(setAuth).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  const input = mutation.mock.calls[0][1] as ReviewedEmploymentJobWorkerInput & { serviceProof: string };
  expect(input).toMatchObject({ jobId: "job-fixture", operation: "claim", body: "{}", issuedAt: expect.any(Number), workerId: expect.any(String) });
  expect(await verifyTelemetryServiceProof(input.serviceProof, await reviewedEmploymentJobProofParts(input))).toBe(true);
  expect(JSON.stringify(input)).not.toContain(FAKE_CREDENTIAL);
});
it("a state observer settling after commit starts cannot cancel the worker's own successful terminal transition", async () => {
  const f = fixture(), originalRpc = f.rpc.getMockImplementation()!, originalFetch = f.fetch.getMockImplementation()!;
  let releaseState!: (value: Reply) => void, stateStarted!: () => void;
  const observed = new Promise<void>(resolve => { stateStarted = resolve; });
  f.fetch.mockImplementation(async (url, init) => { if (!JSON.parse(String(init!.body)).stream) await observed; return originalFetch(url, init); });
  f.rpc.mockImplementation(async input => {
    if (input.operation === "state") { stateStarted(); return new Promise(resolve => { releaseState = resolve; }); }
    if (input.operation === "commit") { releaseState({ status: "ignored", payload: null }); await new Promise<void>(resolve => setTimeout(resolve, 0)); }
    return originalRpc(input);
  });
  await f.run(); expect(f.operations.filter(o => o.operation === "commit")).toHaveLength(1);
  expect(f.operations.filter(o => o.operation === "fail")).toHaveLength(0);
});
it("a wall clock rollback during claim cannot replenish a draft budget already exhausted by queue delay", async () => {
  vi.useFakeTimers(); const f = fixture(60_001), original = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async input => {
    if (input.operation === "claim") vi.setSystemTime(Date.now() - 20_000);
    return original(input);
  });
  await f.run(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.operations.some(o => o.operation === "commit")).toBe(false);
  expect(f.operations.filter(o => o.operation === "fail").map(o => JSON.parse(o.body))).toEqual([{ reason: "deadline_exceeded" }]);
});
it.each(["cancelled", "expired"])("a persisted %s state aborts an in-flight native POST and withholds its late response", async status => {
  const f = fixture(), original = f.rpc.getMockImplementation()!;
  let release!: (response: Response) => void, providerStarted!: () => void, postedSignal: AbortSignal | null | undefined;
  const started = new Promise<void>(resolve => { providerStarted = resolve; });
  f.fetch.mockImplementation(async (_url, init) => { postedSignal = init?.signal; providerStarted(); return new Promise(resolve => { release = resolve; }); });
  f.rpc.mockImplementation(input => input.operation === "state" ? Promise.resolve(ok({ status })) : original(input));
  const pending = f.run(); await started; await pending;
  expect(postedSignal?.aborted).toBe(true);
  release(Response.json({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ candidate: f.input.candidate }) }] }] }));
  await Promise.resolve();
  expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.operations.some(o => o.operation === "passed" || o.operation === "commit")).toBe(false);
  expect(f.operations.filter(o => o.operation === "fail").map(o => JSON.parse(o.body))).toEqual([{ reason: status === "expired" ? "deadline_exceeded" : "cancelled" }]);
});
it("queue age and monotonic time enforce the original verification cutoff despite a wall-clock rollback while reserving inventory", async () => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  const f = fixture(50_000), original = f.rpc.getMockImplementation()!;
  let reserveStarted!: () => void, release!: (reply: Reply) => void;
  const started = new Promise<void>(resolve => { reserveStarted = resolve; });
  f.rpc.mockImplementation(async input => {
    if (input.operation === "reserve" && JSON.parse(input.body).stage === "inventory") {
      vi.setSystemTime(Date.now() - 100_000); reserveStarted(); return new Promise(resolve => { release = resolve; });
    }
    return original(input);
  });
  const pending = f.run(); await started; await vi.advanceTimersByTimeAsync(190_001); await pending;
  release(ok()); await Promise.resolve();
  expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.operations.some(o => o.operation === "commit")).toBe(false);
  expect(f.operations.filter(o => o.operation === "fail").map(o => JSON.parse(o.body))).toEqual([{ reason: "deadline_exceeded" }]);
  expect(vi.getTimerCount()).toBe(0);
});
it("uses the backend's canonical native source binding when fresh RPC object key order changes", async () => {
  const f = fixture(), original = f.rpc.getMockImplementation()!; let reads = 0;
  f.rpc.mockImplementation(input => input.operation === "authority" && ++reads > 1
    ? Promise.resolve(ok({ manifest: f.bundle.manifest, source: Object.fromEntries(Object.entries(f.bundle.source).reverse()) })) : original(input));
  await f.run(); expect(f.fetch).toHaveBeenCalledTimes(4);
  expect(f.operations.filter(o => o.operation === "commit")).toHaveLength(1);
  expect(f.operations.filter(o => o.operation === "reserve").every(o => JSON.parse(o.body).sourceBinding
    === sha(reviewedEmploymentSourceBundleCanonicalJson(f.bundle)))).toBe(true);
});
it("completion duration retains original queue age when the wall clock rolls backward", async () => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  const f = fixture(50_000), original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => { if (!JSON.parse(String(init!.body)).stream) vi.setSystemTime(Date.now() - 20_000); return original(url, init); });
  await f.run(); const completed = f.operations.find(o => o.operation === "commit"); expect(completed).toBeDefined();
  expect(JSON.parse(completed!.body).completion.elapsedMs).toBeGreaterThanOrEqual(50_000);
});
it.each([
  ["draft", 60_000, 0],
  ["inventory", 240_000, 1],
  ["commit", 270_000, 4],
] as const)("a future native timestamp admitted by a slow claim cannot extend the original %s cutoff", async (stage, cutoff, posts) => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  const f = fixture(-5_000), original = f.rpc.getMockImplementation()!;
  let claimStarted!: () => void, releaseClaim!: () => void, stageStarted!: () => void, releaseStage!: (reply: Reply) => void;
  let stagedInput!: ReviewedEmploymentJobWorkerInput;
  const claiming = new Promise<void>(resolve => { claimStarted = resolve; });
  const claimed = new Promise<void>(resolve => { releaseClaim = resolve; });
  const started = new Promise<void>(resolve => { stageStarted = resolve; });
  f.rpc.mockImplementation(async input => {
    if (input.operation === "claim") { claimStarted(); await claimed; }
    if (stage === "commit" ? input.operation === "commit"
      : input.operation === "reserve" && JSON.parse(input.body).stage === stage) {
      stagedInput = input; vi.setSystemTime(Date.now() - 100_000); stageStarted();
      return new Promise(resolve => { releaseStage = resolve; });
    }
    return original(input);
  });
  const pending = module.createReviewedEmploymentJobWorker({ rpc: f.rpc, fetch: f.fetch,
    credential: FAKE_CREDENTIAL, workerId: "worker-fixture", pollIntervalMs: 10_000 }).run(f.claim.jobId);
  await claiming; await vi.advanceTimersByTimeAsync(10_000); releaseClaim(); await started;
  await vi.advanceTimersByTimeAsync(cutoff - 10_000 + 1);
  releaseStage(stage === "commit" ? await original(stagedInput) : ok());
  await pending;
  expect(f.fetch).toHaveBeenCalledTimes(posts);
  expect(f.operations.filter(o => o.operation === "fail").map(o => JSON.parse(o.body))).toEqual([{ reason: "deadline_exceeded" }]);
  expect(vi.getTimerCount()).toBe(0);
});
it("completion duration includes the slow claim even when its native timestamp is ahead of worker entry", async () => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  const f = fixture(-5_000), originalRpc = f.rpc.getMockImplementation()!;
  let claimStarted!: () => void, releaseClaim!: () => void;
  let authorityReads = 0;
  const claiming = new Promise<void>(resolve => { claimStarted = resolve; });
  const claimed = new Promise<void>(resolve => { releaseClaim = resolve; });
  f.rpc.mockImplementation(async input => {
    if (input.operation === "claim") { claimStarted(); await claimed; }
    if (input.operation === "authority" && ++authorityReads === 3) vi.setSystemTime(Date.now() - 100_000);
    return originalRpc(input);
  });
  const pending = f.run(); await claiming; await vi.advanceTimersByTimeAsync(10_000); releaseClaim(); await pending;
  const completed = f.operations.find(o => o.operation === "commit"); expect(completed).toBeDefined();
  expect(JSON.parse(completed!.body).completion.elapsedMs).toBe(10_000);
});
