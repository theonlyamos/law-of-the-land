/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it } from "vitest";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import authSchema from "../betterAuth/schema";
import schema from "../schema";
import { batchIdentityKey } from "../../shared/batch-identity";

const modules = Object.fromEntries(Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [
  path.startsWith("../") ? `./${path.slice(3)}` : `./admin/${path.slice(2)}`, load,
]));
const authModules = Object.fromEntries(Object.entries(import.meta.glob("../betterAuth/**/*.ts")).map(([path, load]) => [`./${path.slice("../betterAuth/".length)}`, load]));
type Backend = TestConvex<typeof schema>;
const preflight = makeFunctionReference<"query">("admin/batchImports:preflight");
const commit = makeFunctionReference<"mutation">("admin/batchImports:commit");
const getStatus = makeFunctionReference<"query">("admin/batchImports:getStatus");
const prepareDuplicateChecks = makeFunctionReference<"mutation">("admin/batchImports:prepareDuplicateChecks");
const createResource = makeFunctionReference<"mutation">("admin/resources:createResource");
const updateResource = makeFunctionReference<"mutation">("admin/resources:updateResource");
const getResource = makeFunctionReference<"query">("admin/resources:getResource");
const oldEnvironment = { enabled: process.env.ADMIN_PANEL_ENABLED, env: process.env.ADMIN_ENVIRONMENT, max: process.env.ADMIN_MAX_DOCUMENT_BYTES };
afterEach(() => {
  for (const [name, value] of Object.entries({ ADMIN_PANEL_ENABLED: oldEnvironment.enabled, ADMIN_ENVIRONMENT: oldEnvironment.env, ADMIN_MAX_DOCUMENT_BYTES: oldEnvironment.max })) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

async function admin(t: Backend, role = "content_manager", assured = true) {
  const identity = await t.run(async ctx => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: {
      name: "Import fixture", email: `${crypto.randomUUID()}@example.com`, emailVerified: true,
      createdAt: now, updatedAt: now, role, banned: false, twoFactorEnabled: true,
    } } });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "session", data: {
      token: crypto.randomUUID(), userId: user._id, expiresAt: now + 60_000, createdAt: now, updatedAt: now,
      ...(assured ? { adminTwoFactorVerifiedAt: now } : {}),
    } } });
    return { subject: user._id, sessionId: session._id };
  });
  return t.withIdentity(identity);
}

async function setup() {
  process.env.ADMIN_PANEL_ENABLED = "true";
  process.env.ADMIN_ENVIRONMENT = "test";
  process.env.ADMIN_MAX_DOCUMENT_BYTES = "1000000";
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  const jurisdictionId = await t.run(async ctx => {
    await ctx.db.insert("featureFlags", { key: "admin_panel", environment: "test", enabled: true, updatedAt: Date.now() });
    return ctx.db.insert("jurisdictions", { code: "GH", name: "Ghana", slug: "ghana", status: "enabled", isDefault: false,
      providerSyncState: "synced", createdBy: "fixture", updatedBy: "fixture", createdAt: Date.now(), updatedAt: Date.now() });
  });
  const client = await admin(t);
  const storageId = await t.run(ctx => ctx.storage.store(new Blob(["abc"], { type: "application/pdf" })));
  const input = {
    jurisdictionId, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", byteSize: 3,
    entry: { filename: "mensah.pdf", title: "Mensah v Mensah", issuer: "Supreme Court of Ghana", officialCitation: "[2012] 1 SCGLR 391",
      sourceUrl: "https://lawfirm.example/reproductions/mensah.pdf", sourceProvenance: "Law firm hosted reproduction of court text; not a certified court copy.",
      topics: ["family"], caseAliases: ["Mensah versus Mensah"], effectiveDate: "2012-02-22" },
  };
  return { t, client, input, storageId };
}

async function seedLegacyResources(t: Backend, jurisdictionId: Id<"jurisdictions">, count: number) {
  return t.run(async ctx => {
    const ids: Id<"legalResources">[] = [];
    for (let index = 0; index < count; index++) {
      ids.push(await ctx.db.insert("legalResources", { jurisdictionId, type: "judgment",
        title: `Republic v Accra Commission case ${index}`, issuer: "Supreme Court",
        officialCitation: `[2000] GHASC ${index}`, officialCitationKey: `[2000] ghasc ${index}`,
        sourceUrl: "https://court.example/judgment.pdf", topics: [], status: "active", catalogPublished: false,
        createdBy: "fixture", updatedBy: "fixture", createdAt: Date.now(), updatedAt: Date.now() }));
    }
    return ids;
  });
}

describe("manifest judgment import", () => {
  it("atomically stores provenance, an unpublished resource and original without asserting review or indexing", async () => {
    const { t, client, input, storageId } = await setup();
    expect(await client.query(preflight, input)).toMatchObject({ kind: "new", indexed: false });
    const result = await client.mutation(commit, { ...input, storageId });
    expect(result).toMatchObject({ kind: "imported", status: "ready_for_review", indexed: false });
    const state = await t.run(async ctx => ({ resource: await ctx.db.get(result.resourceId), version: await ctx.db.get(result.versionId),
      evidence: await ctx.db.query("batchImportEvidence").take(2), decisions: await ctx.db.query("reviewDecisions").take(1),
      jobs: await ctx.db.query("integrationJobs").take(1), audits: await ctx.db.query("auditEvents").take(10) }));
    expect(state.resource).toMatchObject({ type: "judgment", catalogPublished: false, officialCitation: input.entry.officialCitation });
    expect(state.version).toMatchObject({ originalStorageId: storageId, status: "ready_for_review" });
    expect(state.evidence).toHaveLength(1);
    expect(state.evidence[0]).toMatchObject({ sourceUrl: input.entry.sourceUrl, sourceProvenance: input.entry.sourceProvenance, caseAliases: input.entry.caseAliases });
    expect(state.decisions).toHaveLength(0);
    expect(state.jobs).toHaveLength(0);
    expect(state.audits.map(row => row.action)).toEqual(expect.arrayContaining(["resource.created", "document.version_created", "document.batch_imported"]));
  });

  it("recovers a lost commit response or reuploaded identical file without duplicate resources or versions", async () => {
    const { t, client, input, storageId } = await setup();
    const first = await client.mutation(commit, { ...input, storageId });
    const secondStorage = await t.run(ctx => ctx.storage.store(new Blob(["abc"], { type: "application/pdf" })));
    const replay = await client.mutation(commit, { ...input, storageId: secondStorage });
    expect(replay).toMatchObject({ kind: "existing", resourceId: first.resourceId, versionId: first.versionId });
    expect(await client.query(preflight, input)).toMatchObject({ kind: "existing", versionId: first.versionId });
    const counts = await t.run(async ctx => ({ resources: await ctx.db.query("legalResources").take(3), versions: await ctx.db.query("documentVersions").take(3), evidence: await ctx.db.query("batchImportEvidence").take(3) }));
    expect(counts.resources).toHaveLength(1); expect(counts.versions).toHaveLength(1); expect(counts.evidence).toHaveLength(1);
    expect(await t.run(ctx => ctx.db.system.get(storageId))).not.toBeNull();
  });

  it("serializes repeated concurrent commits as one import and one existing original", async () => {
    const { t, client, input, storageId } = await setup();
    const otherStorage = await t.run(ctx => ctx.storage.store(new Blob(["abc"], { type: "application/pdf" })));
    const results = await Promise.all([client.mutation(commit, { ...input, storageId }), client.mutation(commit, { ...input, storageId: otherStorage })]);
    expect(results.map(result => result.kind).sort()).toEqual(["existing", "imported"]);
    expect(results[0].versionId).toBe(results[1].versionId);
  });

  it("blocks citation and alternate-name collisions with a different PDF", async () => {
    const { t, client, input, storageId } = await setup();
    const first = await client.mutation(commit, { ...input, storageId });
    const different = { ...input, sha256: "cb8379ac2098aa165029e3938a51da0bcecfc008fd6795f401178647f96c5b34",
      entry: { ...input.entry, title: "Different caption", officialCitation: "Other Citation", caseAliases: ["MENSAH VS. MENSAH"] } };
    expect(await client.query(preflight, different)).toMatchObject({ kind: "conflict", resourceId: first.resourceId });
    const secondStorage = await t.run(ctx => ctx.storage.store(new Blob(["def"], { type: "application/pdf" })));
    expect(await client.mutation(commit, { ...different, storageId: secondStorage })).toMatchObject({ kind: "conflict" });
    expect(await t.run(ctx => ctx.db.query("legalResources").take(2))).toHaveLength(1);
  });

  it("detects an exact hash in a pre-existing resource even with unrelated metadata", async () => {
    const { t, client, input, storageId } = await setup();
    const first = await client.mutation(commit, { ...input, storageId });
    const changed = { ...input, entry: { ...input.entry, title: "A completely different caption", officialCitation: "Civil Appeal 99", caseAliases: [] } };
    expect(await client.query(preflight, changed)).toMatchObject({ kind: "existing", versionId: first.versionId });
    expect(await t.run(ctx => ctx.db.query("legalResources").take(2))).toHaveLength(1);
  });

  it("detects a legacy citation without an import identity registration", async () => {
    const { t, client, input } = await setup();
    const resourceId = await t.run(ctx => ctx.db.insert("legalResources", { jurisdictionId: input.jurisdictionId,
      type: "judgment", title: "Legacy case title", issuer: "Supreme Court", officialCitation: input.entry.officialCitation,
      officialCitationKey: input.entry.officialCitation.normalize("NFKC").toLowerCase(), sourceUrl: input.entry.sourceUrl,
      topics: [], status: "active", createdBy: "fixture", updatedBy: "fixture", createdAt: Date.now(), updatedAt: Date.now() }));
    expect(await client.query(preflight, input)).toMatchObject({ kind: "conflict", message: "Prepare catalog duplicate checks before importing." });
    expect(await client.mutation(prepareDuplicateChecks, { jurisdictionId: input.jurisdictionId })).toEqual({ processed: 1, done: true });
    expect(await client.query(preflight, input)).toMatchObject({ kind: "conflict", resourceId });
  });

  it("uses exact indexed identities despite many common caption terms and long case names", async () => {
    const { t, client, input } = await setup();
    await seedLegacyResources(t, input.jurisdictionId, 35);
    await client.mutation(prepareDuplicateChecks, { jurisdictionId: input.jurisdictionId });
    const title = "Republic v Accra Commission regarding the alleged failure of the municipal assembly to consult the affected market traders before relocation";
    expect(title.split(/\s+/).length).toBeGreaterThan(16);
    expect(await client.query(preflight, { ...input, entry: { ...input.entry, title, caseAliases: [] } })).toMatchObject({ kind: "new" });
    const changedCitation = { ...input, entry: { ...input.entry, title: "Different legacy caption", officialCitation: "2000-GHASC-1", caseAliases: [] } };
    expect(await client.query(preflight, changedCitation)).toMatchObject({ kind: "conflict" });
  });

  it("prepares at most 100 legacy rows per call and safely resumes without touching lifecycle metadata", async () => {
    const { t, client, input } = await setup();
    const ids = await seedLegacyResources(t, input.jurisdictionId, 205);
    const original = await t.run(ctx => ctx.db.get(ids[0]));
    expect(await client.mutation(prepareDuplicateChecks, { jurisdictionId: input.jurisdictionId })).toEqual({ processed: 100, done: false });
    expect(await client.query(preflight, input)).toMatchObject({ kind: "conflict", message: "Prepare catalog duplicate checks before importing." });
    expect(await client.mutation(prepareDuplicateChecks, { jurisdictionId: input.jurisdictionId })).toEqual({ processed: 100, done: false });
    expect(await client.mutation(prepareDuplicateChecks, { jurisdictionId: input.jurisdictionId })).toEqual({ processed: 5, done: true });
    expect(await client.mutation(prepareDuplicateChecks, { jurisdictionId: input.jurisdictionId })).toEqual({ processed: 0, done: true });
    const after = await t.run(ctx => ctx.db.get(ids[0]));
    expect(after).toEqual({ ...original, batchTitleKey: batchIdentityKey(original!.title), batchCitationKey: batchIdentityKey(original!.officialCitation) });
    expect(await t.run(ctx => ctx.db.query("auditEvents").take(10))).toHaveLength(3);
    expect(await client.query(preflight, input)).toMatchObject({ kind: "new" });
  });

  it("finishes partially prepared rows and keeps keys current during normal create and metadata update operations", async () => {
    const { t, client, input } = await setup();
    const [legacyId] = await seedLegacyResources(t, input.jurisdictionId, 1);
    await t.run(ctx => ctx.db.patch(legacyId, { batchTitleKey: "oldpartialkey" }));
    const createArgs = { jurisdictionId: input.jurisdictionId, type: "judgment", title: "Ali versus Kofi", issuer: "Supreme Court",
      officialCitation: "[2026] GHASC 77", sourceUrl: input.entry.sourceUrl, topics: [], reason: "Record case metadata for review" };
    const [, createdId] = await Promise.all([
      client.mutation(prepareDuplicateChecks, { jurisdictionId: input.jurisdictionId }),
      client.mutation(createResource, createArgs),
    ]);
    expect(await client.query(getResource, { id: createdId })).toMatchObject({ batchTitleKey: "alivkofi", batchCitationKey: "2026ghasc77" });
    await Promise.all([
      client.mutation(prepareDuplicateChecks, { jurisdictionId: input.jurisdictionId }),
      client.mutation(updateResource, { id: legacyId, title: "Amani vs. Kwame", issuer: "Supreme Court",
        officialCitation: "[2026] GHASC 88", sourceUrl: input.entry.sourceUrl, topics: [], reason: "Correct the case caption and citation" }),
    ]);
    const updated = await client.query(getResource, { id: legacyId });
    expect(updated).toMatchObject({ batchTitleKey: "amanivkwame", batchCitationKey: "2026ghasc88" });
    expect(await client.mutation(prepareDuplicateChecks, { jurisdictionId: input.jurisdictionId })).toEqual({ processed: 0, done: true });
    expect(await client.query(preflight, { ...input, entry: { ...input.entry, title: "Amani versus Kwame", caseAliases: [] } })).toMatchObject({ kind: "conflict", resourceId: legacyId });
  });

  it("verifies bytes before returning existing and rolls back invalid uploads without creating resources", async () => {
    const { t, client, input, storageId } = await setup();
    await expect(client.mutation(commit, { ...input, sha256: "0".repeat(64), storageId })).rejects.toThrow("DOCUMENT_CHECKSUM_MISMATCH");
    expect(await t.run(ctx => ctx.db.query("legalResources").take(1))).toHaveLength(0);
    await client.mutation(commit, { ...input, storageId });
    const wrongStorage = await t.run(ctx => ctx.storage.store(new Blob(["def"], { type: "application/pdf" })));
    await expect(client.mutation(commit, { ...input, storageId: wrongStorage })).rejects.toThrow("DOCUMENT_CHECKSUM_MISMATCH");
  });

  it("requires enabled administration, write permissions and assured two-factor authentication", async () => {
    const { t, input, storageId } = await setup();
    const auditor = await admin(t, "auditor");
    await expect(auditor.query(preflight, input)).rejects.toThrow("ADMIN_FORBIDDEN");
    await expect(auditor.mutation(commit, { ...input, storageId })).rejects.toThrow("ADMIN_FORBIDDEN");
    await expect(auditor.mutation(prepareDuplicateChecks, { jurisdictionId: input.jurisdictionId })).rejects.toThrow("ADMIN_FORBIDDEN");
    await expect(t.query(preflight, input)).rejects.toThrow();
    const unassured = await admin(t, "content_manager", false);
    await expect(unassured.mutation(commit, { ...input, storageId })).rejects.toThrow();
    await expect(unassured.mutation(prepareDuplicateChecks, { jurisdictionId: input.jurisdictionId })).rejects.toThrow();
    process.env.ADMIN_PANEL_ENABLED = "false";
    const manager = await admin(t);
    await expect(manager.query(preflight, input)).rejects.toThrow("ADMIN_DISABLED");
    await expect(manager.mutation(prepareDuplicateChecks, { jurisdictionId: input.jurisdictionId })).rejects.toThrow("ADMIN_DISABLED");
  });

  it("validates manifest provenance, aliases, dates, filenames and source protocols at the server boundary", async () => {
    const { client, input } = await setup();
    for (const entry of [
      { ...input.entry, sourceProvenance: " " }, { ...input.entry, caseAliases: [""] },
      { ...input.entry, effectiveDate: "2026-02-31" }, { ...input.entry, filename: "../case.pdf" },
      { ...input.entry, sourceUrl: "http://lawfirm.example/case.pdf" }, { ...input.entry, topics: Array.from({ length: 9 }, (_, i) => `topic${i}`) },
    ]) await expect(client.query(preflight, { ...input, entry })).rejects.toThrow();
  });

  it("rejects draft and archived jurisdictions before creating a resource", async () => {
    const { t, client, input, storageId } = await setup();
    for (const status of ["draft", "archived"] as const) {
      await t.run(ctx => ctx.db.patch(input.jurisdictionId, { status }));
      await expect(client.query(preflight, input)).rejects.toThrow("JURISDICTION_NOT_ENABLED");
      await expect(client.mutation(commit, { ...input, storageId })).rejects.toThrow("JURISDICTION_NOT_ENABLED");
    }
    expect(await t.run(ctx => ctx.db.query("legalResources").take(1))).toHaveLength(0);
  });

  it("returns persisted evidence and current publication/indexing state to authorized reviewers", async () => {
    const { t, client, input, storageId } = await setup();
    const first = await client.mutation(commit, { ...input, storageId });
    const reviewer = await admin(t, "content_reviewer");
    expect(await reviewer.query(getStatus, { versionId: first.versionId })).toMatchObject({ sourceProvenance: input.entry.sourceProvenance, status: "ready_for_review", indexed: false });
    await t.run(ctx => ctx.db.patch(first.versionId as Id<"documentVersions">, { status: "publishing" }));
    expect(await reviewer.query(getStatus, { versionId: first.versionId })).toMatchObject({ status: "publishing", indexed: false });
    await t.run(ctx => ctx.db.patch(first.versionId as Id<"documentVersions">, { status: "published", geminiIndexedAt: Date.now(), geminiDocumentName: "fileSearchStores/test/documents/case" }));
    expect(await reviewer.query(getStatus, { versionId: first.versionId })).toMatchObject({ status: "published", indexed: true });
  });
});
