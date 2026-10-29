/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import authSchema from "./betterAuth/schema";
import schema from "./schema";
import { blankKey } from "../shared/document-draft";
import polarSchema from "../node_modules/@convex-dev/polar/src/component/schema";

const modules = import.meta.glob("./**/*.ts");
const authModules = Object.fromEntries(Object.entries(import.meta.glob("./betterAuth/**/*.ts")).map(([path, load]) => [`./${path.slice("./betterAuth/".length)}`, load]));
const polarModules = Object.fromEntries(Object.entries(import.meta.glob("../node_modules/@convex-dev/polar/src/component/**/*.ts"))
  .map(([path, load]) => [`./${path.slice("../node_modules/@convex-dev/polar/src/component/".length)}`, load]));
type Backend = TestConvex<typeof schema>;
type Client = ReturnType<Backend["withIdentity"]>;

const prepare = makeFunctionReference<"mutation">("chatAttachments:prepareUpload");
const finalize = makeFunctionReference<"mutation">("chatAttachments:finalizeUpload");
const savePlan = makeFunctionReference<"mutation">("documentDrafts:savePlan");
const saveClauses = makeFunctionReference<"mutation">("documentDrafts:saveClauses");
const saveFormalities = makeFunctionReference<"mutation">("documentDrafts:saveFormalities");
const complete = makeFunctionReference<"mutation">("documentDrafts:complete");
const fail = makeFunctionReference<"mutation">("documentDrafts:fail");
const deleteBatch = makeFunctionReference<"mutation">("documentDrafts:deleteForSessionBatch");
const planningInput = makeFunctionReference<"query">("documentDrafts:planningInput");
const draftingInput = makeFunctionReference<"query">("documentDrafts:draftingInput");

function backend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  t.registerComponent("polar", polarSchema, polarModules);
  return t;
}

async function user(t: Backend) {
  const identity = await t.run(async (ctx) => {
    const now = Date.now();
    const account = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: {
      name: "Draft owner", email: `${crypto.randomUUID()}@example.com`, emailVerified: true, createdAt: now, updatedAt: now,
      role: "user", banned: false, twoFactorEnabled: false,
    } } });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "session", data: {
      token: crypto.randomUUID(), userId: account._id, expiresAt: now + 7 * 86_400_000, createdAt: now, updatedAt: now,
    } } });
    return { subject: account._id, sessionId: session._id };
  });
  return { client: t.withIdentity(identity), userId: identity.subject };
}

async function fixture() {
  const t = backend();
  const owner = await user(t);
  const jurisdictionId = await t.run(async (ctx) => {
    const now = Date.now();
    const id = await ctx.db.insert("jurisdictions", {
      name: "Ghana", slug: crypto.randomUUID(), status: "enabled", kind: "geographic", visibility: "public", isDefault: false,
      providerSyncState: "pending", createdAt: now, updatedAt: now, createdBy: "fixture", updatedBy: "fixture",
    });
    await ctx.db.insert("geographicJurisdictions", {
      jurisdictionId: id, googlePlaceId: crypto.randomUUID(), level: "country", latitude: 0, longitude: 0, formattedAddress: "Ghana",
      createdAt: now, updatedAt: now,
    });
    return id;
  });
  const externalId = crypto.randomUUID();
  await owner.client.mutation(api.chats.ensure, { externalId, jurisdictionId });
  const sessionId = await t.run(async (ctx) => (await ctx.db.query("chatSessions")
    .withIndex("by_user_externalId", (q) => q.eq("userId", owner.userId).eq("externalId", externalId)).unique())!._id);
  return { t, ...owner, jurisdictionId, externalId, sessionId };
}

async function upload(t: Backend, client: Client, externalId: string, content = "1. Rent is due on the first day.\n2. The landlord may enter at any time.", filename = "lease.txt") {
  const bytes = new TextEncoder().encode(content);
  const { attachmentId } = await client.mutation(prepare, { externalId, filename, mimeType: "text/plain", byteSize: bytes.length });
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob([bytes], { type: "text/plain" })));
  await client.mutation(finalize, { attachmentId, storageId, mimeType: "text/plain", kind: "text", extractedText: content });
  return attachmentId as Id<"chatAttachments">;
}

async function requestDraft(f: Awaited<ReturnType<typeof fixture>>, clientId = "user-1", request = "Draft a tenancy agreement for my flat", attachmentId?: Id<"chatAttachments">) {
  await f.client.mutation(api.chats.appendMessages, {
    externalId: f.externalId, lastMessage: request,
    messages: [{ role: "user" as const, content: request, clientId, createdAt: 100, ...(attachmentId ? { attachmentIds: [attachmentId] } : {}) }],
  });
  const { draftId } = await f.client.mutation(api.documentDrafts.create, { externalId: f.externalId, userClientId: clientId, request, ...(attachmentId ? { attachmentId } : {}) });
  return draftId;
}

const PLAN = {
  documentType: "Tenancy agreement",
  title: "Tenancy Agreement",
  summary: "A one-year residential tenancy for a flat.",
  isLegalDocument: true,
  roleOptions: [{ id: "landlord", label: "Landlord" }, { id: "tenant", label: "Tenant" }],
  suggestedRoleId: "landlord",
  suggestedAudience: "personal" as const,
  questions: [
    { id: "rent", label: "Monthly rent", kind: "number" as const, options: [], suggested: "GH₵ 2,000" },
    { id: "start", label: "Start date", kind: "date" as const, options: [] },
  ],
  sections: [
    { heading: "Parties", purpose: "Name the parties.", kind: "opening" as const },
    { heading: "Rent", purpose: "Rent and advance.", kind: "clause" as const },
    { heading: "Repairs", purpose: "Who repairs what.", kind: "clause" as const },
    { heading: "Signatures", purpose: "Execution.", kind: "signatures" as const },
  ],
  sourceNotes: "",
};

function clause(sectionOrdinal: number, overrides: Record<string, unknown> = {}) {
  return {
    sectionOrdinal, heading: PLAN.sections[sectionOrdinal].heading, text: `Text for ${PLAN.sections[sectionOrdinal].heading}.`,
    basis: "choice" as const, why: "Records the details.", lawSummary: "", provisions: [], citations: [], ...overrides,
  };
}

async function startDrafting(t: Backend, draftId: Id<"documentDrafts">) {
  // Stands in for `start`, which needs a ready research library.
  await t.run(async (ctx) => {
    await ctx.db.insert("documentDraftResearch", { draftId, attempt: 1, research: { authorizedScopeSize: 1, partialCoverage: true, stores: [] } });
    await ctx.db.patch(draftId, {
      status: "drafting", roleId: "landlord", roleLabel: "Landlord", audience: "professional",
      answers: [{ questionId: "rent", label: "Monthly rent", value: "GH₵ 2,000" }], draftedCount: 0, draftTotal: 4, startRequested: false,
    });
  });
}

async function completedDraft(f: Awaited<ReturnType<typeof fixture>>) {
  const draftId = await requestDraft(f);
  await f.t.mutation(savePlan, { draftId, attempt: 1, plan: PLAN });
  await startDrafting(f.t, draftId);
  await f.t.mutation(saveClauses, {
    draftId, attempt: 1, pool: [], draftedOrdinals: [0, 1, 2, 3],
    clauses: [
      clause(0, { text: "This agreement is between [Landlord's full name] and [Tenant's full name]." }),
      // A legal basis without a valid source is shown as "No law cited".
      clause(1, { basis: "required", lawSummary: "Advance rent is capped at six months.", provisions: ["Section 25"] }),
      clause(2, { basis: "common" }),
      clause(3),
    ],
  });
  await f.t.mutation(complete, { draftId, attempt: 1 });
  return draftId;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CONVEX_CLOUD_URL", undefined);
  vi.stubEnv("CONVEX_SITE_URL", undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("document drafts", () => {
  it("starts a draft only for a saved request, once per message, counting one question", async () => {
    const f = await fixture();
    await expect(f.client.mutation(api.documentDrafts.create, { externalId: f.externalId, userClientId: "user-0", request: "Draft a will" }))
      .rejects.toThrow("DOCUMENT_DRAFT_UNAVAILABLE");
    const draftId = await requestDraft(f);
    const again = await f.client.mutation(api.documentDrafts.create, { externalId: f.externalId, userClientId: "user-1", request: "Again" });
    expect(again.draftId).toBe(draftId);
    const list = await f.client.query(api.documentDrafts.listForChat, { externalId: f.externalId });
    expect(list).toMatchObject([{ id: draftId, userClientId: "user-1", status: "planning", request: "Draft a tenancy agreement for my flat", jurisdictionName: "Ghana", version: 1 }]);
    expect(await f.t.run((ctx) => ctx.db.query("dailyUsage").take(5))).toMatchObject([{ count: 1 }]);
  });

  it("uses a file sent with the request as background, and rejects one sent elsewhere", async () => {
    const f = await fixture();
    const loose = await upload(f.t, f.client, f.externalId, "Old lease", "old.txt");
    await f.client.mutation(api.chats.appendMessages, { externalId: f.externalId, lastMessage: "x", messages: [{ role: "user" as const, content: "Draft a lease", clientId: "user-9", createdAt: 50 }] });
    await expect(f.client.mutation(api.documentDrafts.create, { externalId: f.externalId, userClientId: "user-9", request: "Draft a lease", attachmentId: loose }))
      .rejects.toThrow("DOCUMENT_DRAFT_UNAVAILABLE");

    const attachmentId = await upload(f.t, f.client, f.externalId, "Landlord: A. Mensah. Rent GH₵ 2,000.", "notes.txt");
    const draftId = await requestDraft(f, "user-2", "Draft a lease from these notes", attachmentId);
    const input = await f.t.query(planningInput, { draftId, attempt: 1 });
    expect(input).toMatchObject({ request: "Draft a lease from these notes", attachment: { filename: "notes.txt", extractedText: "Landlord: A. Mensah. Rent GH₵ 2,000." } });
    expect((await f.client.query(api.documentDrafts.listForChat, { externalId: f.externalId })).find((item) => item.id === draftId)?.attachmentFilename).toBe("notes.txt");
  });

  it("keeps drafts private to their owner", async () => {
    const f = await fixture();
    const draftId = await requestDraft(f);
    const other = await user(f.t);
    await expect(other.client.query(api.documentDrafts.get, { draftId })).resolves.toBeNull();
    await expect(other.client.query(api.documentDrafts.listForChat, { externalId: f.externalId })).resolves.toEqual([]);
    await expect(other.client.mutation(api.documentDrafts.cancel, { draftId })).rejects.toThrow("DOCUMENT_DRAFT_UNAVAILABLE");
  });

  it("asks the setup questions once planned, and needs the law library to start", async () => {
    const f = await fixture();
    const draftId = await requestDraft(f);
    await f.t.mutation(savePlan, { draftId, attempt: 0, plan: { ...PLAN, title: "Stale" } });
    await f.t.mutation(savePlan, { draftId, attempt: 1, plan: PLAN });
    const [summary] = await f.client.query(api.documentDrafts.listForChat, { externalId: f.externalId });
    expect(summary).toMatchObject({ status: "awaiting_input", title: "Tenancy Agreement", sectionCount: 4, suggestedRoleId: "landlord", questions: PLAN.questions });
    await expect(f.client.mutation(api.documentDrafts.start, { draftId, roleId: "buyer", audience: "personal", answers: [] }))
      .rejects.toThrow("DOCUMENT_DRAFT_RESEARCH_UNAVAILABLE");
    expect((await f.client.query(api.documentDrafts.get, { draftId }))?.draft.status).toBe("awaiting_input");
  });

  it("downgrades clauses without a valid source, ignores sections outside the batch and completes with counts", async () => {
    const f = await fixture();
    const draftId = await requestDraft(f);
    await f.t.mutation(savePlan, { draftId, attempt: 1, plan: PLAN });
    await startDrafting(f.t, draftId);
    const input = await f.t.query(draftingInput, { draftId, attempt: 1 });
    expect(input.context).toMatchObject({ side: "Landlord", audience: "professional", answers: [{ label: "Monthly rent", value: "GH₵ 2,000" }] });
    expect(input.sections).toHaveLength(4);

    await f.t.mutation(saveClauses, { draftId, attempt: 1, pool: [], draftedOrdinals: [0, 1], clauses: [
      clause(0, { text: "Between [Landlord's full name] and [Tenant's full name]." }),
      clause(1, { basis: "required", lawSummary: "Advance rent is capped.", citations: [{ jurisdictionId: f.jurisdictionId, resourceId: "missing", versionId: "missing", providerStoreName: "fileSearchStores/none" }] }),
      clause(2),
    ] });
    expect((await f.client.query(api.documentDrafts.listForChat, { externalId: f.externalId }))[0]).toMatchObject({ status: "drafting", draftedCount: 2, draftTotal: 4 });
    await f.t.mutation(saveClauses, { draftId, attempt: 1, pool: [], draftedOrdinals: [2, 3], clauses: [clause(2, { basis: "protects", lawSummary: "x" }), clause(3)] });
    await f.t.mutation(saveFormalities, { draftId, attempt: 1, pool: [], items: [
      { title: "Stamp it", detail: "Pay stamp duty.", basis: "required", lawSummary: "Instruments are stamped.", provisions: ["s. 2"], citations: [] },
    ] });
    await f.t.mutation(complete, { draftId, attempt: 1 });

    const data = await f.client.query(api.documentDrafts.get, { draftId });
    expect(data!.draft).toMatchObject({ status: "completed", counts: { required: 0, protects: 0, common: 2, choice: 2 }, placeholderCount: 2 });
    expect(data!.partialCoverage).toBe(true);
    expect(data!.formalities).toEqual([{ title: "Stamp it", detail: "Pay stamp duty.", basis: "common", citations: [] }]);
    expect(data!.clauses.map((item) => [item.ordinal, item.kind, item.basis])).toEqual([[0, "opening", "choice"], [1, "clause", "common"], [2, "clause", "common"], [3, "signatures", "choice"]]);
    expect(data!.clauses[1]).toMatchObject({ lawSummary: "", citations: [] });
  });

  it("does not finish a draft until every planned section is saved", async () => {
    const f = await fixture();
    const draftId = await requestDraft(f);
    await f.t.mutation(savePlan, { draftId, attempt: 1, plan: PLAN });
    await startDrafting(f.t, draftId);
    await f.t.mutation(saveClauses, { draftId, attempt: 1, pool: [], draftedOrdinals: [0, 1], clauses: [clause(0), clause(1)] });
    await f.t.mutation(complete, { draftId, attempt: 1 });
    expect((await f.client.query(api.documentDrafts.get, { draftId }))!.draft).toMatchObject({ status: "failed", failure: "internal" });
  });

  it("saves the person's edits as a new version and keeps at least one clause", async () => {
    const f = await fixture();
    const draftId = await completedDraft(f);
    let data = (await f.client.query(api.documentDrafts.get, { draftId }))!;
    const [first, second] = data.clauses;
    await expect(f.client.mutation(api.documentDrafts.updateClause, { clauseId: first.id, heading: "Parties", text: "   " })).rejects.toThrow("DOCUMENT_DRAFT_EMPTY_CLAUSE");
    await f.client.mutation(api.documentDrafts.updateClause, { clauseId: first.id, heading: " The  parties ", text: "Between A. Mensah\r\nand K. Owusu." });
    await f.client.mutation(api.documentDrafts.removeClause, { clauseId: second.id });
    data = (await f.client.query(api.documentDrafts.get, { draftId }))!;
    expect(data.draft.version).toBe(3);
    expect(data.clauses).toHaveLength(3);
    expect(data.clauses[0]).toMatchObject({ heading: "The parties", text: "Between A. Mensah\nand K. Owusu.", edited: true });
    for (const item of data.clauses.slice(1)) await f.client.mutation(api.documentDrafts.removeClause, { clauseId: item.id });
    await expect(f.client.mutation(api.documentDrafts.removeClause, { clauseId: data.clauses[0].id })).rejects.toThrow("DOCUMENT_DRAFT_LAST_CLAUSE");
    // Rewriting a clause needs the law library, like starting a draft.
    await expect(f.client.mutation(api.documentDrafts.reviseClause, { clauseId: data.clauses[0].id, instruction: "Shorter" })).rejects.toThrow("DOCUMENT_DRAFT_RESEARCH_UNAVAILABLE");
  });

  it("fills a blank in every clause that uses it, or in one clause only", async () => {
    const f = await fixture();
    const draftId = await completedDraft(f);
    const get = async () => (await f.client.query(api.documentDrafts.get, { draftId }))!;
    const [parties, , , signatures] = (await get()).clauses;
    await f.t.run(async (ctx) => { await ctx.db.patch(signatures.id, { text: "Signed by [landlord’s full name]." }); });
    const key = blankKey("[Landlord's full name]");
    const setBlank = (clauseId: Id<"documentDraftClauses">, value: string, everywhere: boolean) =>
      f.client.mutation(api.documentDrafts.setBlank, { clauseId, key, value, everywhere });

    await expect(f.client.mutation(api.documentDrafts.setBlank, { clauseId: parties.id, key: "monthly rent", value: "1", everywhere: true }))
      .rejects.toThrow("DOCUMENT_DRAFT_UNKNOWN_BLANK");
    await setBlank(parties.id, "  Kwame [Mensah]\n ", true);
    let data = await get();
    expect(data.clauses[0].text).toBe("This agreement is between Kwame Mensah and [Tenant's full name].");
    expect(data.clauses[3].text).toBe("Signed by Kwame Mensah.");
    expect(data.clauses[0].parts).toContainEqual({ kind: "blank", key, placeholder: "[Landlord's full name]", value: "Kwame Mensah", own: false });
    expect(data.draft).toMatchObject({ placeholderCount: 1, version: 1 });

    await setBlank(signatures.id, "K. Mensah", false);
    data = await get();
    expect(data.clauses[0].text).toBe("This agreement is between Kwame Mensah and [Tenant's full name].");
    expect(data.clauses[3]).toMatchObject({ text: "Signed by K. Mensah.", edited: false });
    expect(data.clauses[3].parts).toContainEqual({ kind: "blank", key, placeholder: "[landlord’s full name]", value: "K. Mensah", own: true });

    // Filling everywhere replaces the clause's own value; an empty value opens the blank again.
    await setBlank(parties.id, "Ama Owusu", true);
    expect((await get()).clauses[3].text).toBe("Signed by Ama Owusu.");
    await setBlank(parties.id, "", true);
    data = await get();
    expect(data.clauses[3].text).toBe("Signed by [landlord’s full name].");
    expect(data.draft.placeholderCount).toBe(3);
    expect(await f.t.run((ctx) => ctx.db.query("documentDraftBlanks").collect())).toEqual([]);
  });

  it("discards work from a stopped attempt and resumes from the setup on retry", async () => {
    const f = await fixture();
    const draftId = await requestDraft(f);
    await f.t.mutation(savePlan, { draftId, attempt: 1, plan: PLAN });
    await startDrafting(f.t, draftId);
    await f.client.mutation(api.documentDrafts.cancel, { draftId });
    await f.t.mutation(saveClauses, { draftId, attempt: 1, pool: [], draftedOrdinals: [0], clauses: [clause(0)] });
    await f.t.mutation(fail, { draftId, attempt: 1, failure: "provider" });
    let data = await f.client.query(api.documentDrafts.get, { draftId });
    expect(data!.draft).toMatchObject({ status: "cancelled", failure: "cancelled" });
    expect(data!.clauses).toEqual([]);

    await expect(f.client.mutation(api.documentDrafts.retry, { draftId })).rejects.toThrow("DOCUMENT_DRAFT_RESEARCH_UNAVAILABLE");
    await f.t.run(async (ctx) => { await ctx.db.patch(draftId, { roleId: undefined, roleLabel: undefined }); });
    await f.client.mutation(api.documentDrafts.retry, { draftId });
    data = await f.client.query(api.documentDrafts.get, { draftId });
    expect(data!.draft).toMatchObject({ status: "awaiting_input", draftedCount: 0 });
    expect(data!.draft.failure).toBeUndefined();
  });

  it("deletes drafts and their parts with the chat", async () => {
    const f = await fixture();
    const draftId = await completedDraft(f);
    const [parties] = (await f.client.query(api.documentDrafts.get, { draftId }))!.clauses;
    await f.client.mutation(api.documentDrafts.setBlank, { clauseId: parties.id, key: blankKey("[Tenant's full name]"), value: "Ama Owusu", everywhere: true });
    for (let round = 0; round < 5; round += 1) {
      const { hasMore } = await f.t.mutation(deleteBatch, { sessionId: f.sessionId });
      if (!hasMore) break;
    }
    const left = await f.t.run(async (ctx) => ({
      drafts: await ctx.db.query("documentDrafts").take(1),
      clauses: await ctx.db.query("documentDraftClauses").take(1),
      research: await ctx.db.query("documentDraftResearch").take(1),
      blanks: await ctx.db.query("documentDraftBlanks").take(1),
    }));
    expect(left).toEqual({ drafts: [], clauses: [], research: [], blanks: [] });
  });
});
