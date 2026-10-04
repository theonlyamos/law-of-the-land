/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import authSchema from "./betterAuth/schema";
import schema from "./schema";
import { completeGovernedInteractionProofParts } from "./chats";
import { createChatAttachmentProof } from "./lib/chatAttachmentProof";
import { createOpaqueTelemetryToken, createTelemetryServiceProof } from "./lib/telemetryProof";
import { ATTACHMENT_DRAFT_TTL_MS } from "./lib/chatAttachmentContracts";

const modules = import.meta.glob("./**/*.ts");
const authModules = Object.fromEntries(Object.entries(import.meta.glob("./betterAuth/**/*.ts")).map(([path, load]) => [`./${path.slice("./betterAuth/".length)}`, load]));
type Backend = TestConvex<typeof schema>;
type Client = ReturnType<Backend["withIdentity"]>;
const prepare = makeFunctionReference<"mutation">("chatAttachments:prepareUpload");
const finalize = makeFunctionReference<"mutation">("chatAttachments:finalizeUpload");
const remove = makeFunctionReference<"mutation">("chatAttachments:remove");
const resolve = makeFunctionReference<"query">("chatAttachments:resolve");
const getFile = makeFunctionReference<"query">("chatAttachments:getFile");
const expire = makeFunctionReference<"mutation">("chatAttachments:expireDraft");
const cleanup = makeFunctionReference<"mutation">("chatAttachments:deleteSessionBatch");
const complete = makeFunctionReference<"mutation">("chats:completeGovernedInteraction");
const previous = { secret: process.env.TELEMETRY_INGEST_SECRET, site: process.env.SITE_URL, environment: process.env.ADMIN_ENVIRONMENT };

function backend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function user(t: Backend) {
  const identity = await t.run(async ctx => {
    const now = Date.now();
    const account = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: { name: "Attachment owner", email: `${crypto.randomUUID()}@example.com`, emailVerified: true, createdAt: now, updatedAt: now, role: "user", banned: false, twoFactorEnabled: false } } });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "session", data: { token: crypto.randomUUID(), userId: account._id, expiresAt: now + 7 * 86_400_000, createdAt: now, updatedAt: now } } });
    return { subject: account._id, sessionId: session._id };
  });
  return { client: t.withIdentity(identity), userId: identity.subject };
}

async function fixture() {
  const t = backend(), owner = await user(t);
  const jurisdictionId = await t.run(async ctx => {
    const now = Date.now();
    const id = await ctx.db.insert("jurisdictions", { name: "Ghana", slug: crypto.randomUUID(), status: "enabled", kind: "geographic", visibility: "public", isDefault: false, providerSyncState: "pending", createdAt: now, updatedAt: now, createdBy: "fixture", updatedBy: "fixture" });
    await ctx.db.insert("geographicJurisdictions", { jurisdictionId: id, googlePlaceId: crypto.randomUUID(), level: "country", latitude: 0, longitude: 0, formattedAddress: "Ghana", createdAt: now, updatedAt: now });
    return id;
  });
  const externalId = crypto.randomUUID();
  await owner.client.mutation(api.chats.ensure, { externalId, jurisdictionId });
  const sessionId = await t.run(async ctx => (await ctx.db.query("chatSessions").withIndex("by_user_externalId", q => q.eq("userId", owner.userId).eq("externalId", externalId)).unique())!._id);
  return { t, ...owner, jurisdictionId, externalId, sessionId };
}

async function ready(t: Backend, client: Client, externalId: string, content = "Private attachment", filename = "notes.txt") {
  const bytes = new TextEncoder().encode(content);
  const { attachmentId } = await client.mutation(prepare, { externalId, filename, mimeType: "text/plain", byteSize: bytes.length });
  const storageId = await t.run(ctx => ctx.storage.store(new Blob([bytes], { type: "text/plain" })));
  await client.mutation(finalize, { attachmentId, storageId, mimeType: "text/plain", kind: "text", extractedText: content });
  return { attachmentId: attachmentId as Id<"chatAttachments">, storageId };
}

function userMessage(attachmentId: Id<"chatAttachments">, clientId = "user-1") {
  return { role: "user" as const, content: "Summarize this file", clientId, createdAt: 100, attachmentIds: [attachmentId] };
}

beforeEach(() => {
  process.env.TELEMETRY_INGEST_SECRET = "chat-attachment-test-secret-at-least-32-chars";
  process.env.SITE_URL = "https://app.example.com";
  process.env.ADMIN_ENVIRONMENT = "test";
});
afterEach(() => {
  for (const [key, value] of Object.entries({ TELEMETRY_INGEST_SECRET: previous.secret, SITE_URL: previous.site, ADMIN_ENVIRONMENT: previous.environment })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  vi.useRealTimers();
});

describe("private chat attachments", () => {
  it("bounds prepared files by type, individual size, count and combined size", async () => {
    const f = await fixture();
    await expect(f.client.mutation(prepare, { externalId: f.externalId, filename: "script.html", mimeType: "text/html", byteSize: 12 })).rejects.toThrow("CHAT_ATTACHMENT_INVALID");
    await expect(f.client.mutation(prepare, { externalId: f.externalId, filename: "huge.pdf", mimeType: "application/pdf", byteSize: 10 * 1024 * 1024 + 1 })).rejects.toThrow("CHAT_ATTACHMENT_INVALID");
    for (let index = 0; index < 5; index++) await f.client.mutation(prepare, { externalId: f.externalId, filename: "notes.txt", mimeType: "", byteSize: 1 });
    await expect(f.client.mutation(prepare, { externalId: f.externalId, filename: "notes.txt", mimeType: "text/plain", byteSize: 1 })).rejects.toThrow("CHAT_ATTACHMENT_LIMIT");
    const anotherId = crypto.randomUUID();
    await f.client.mutation(api.chats.ensure, { externalId: anotherId, jurisdictionId: f.jurisdictionId });
    for (let index = 0; index < 2; index++) await f.client.mutation(prepare, { externalId: anotherId, filename: "scan.pdf", mimeType: "application/pdf", byteSize: 10 * 1024 * 1024 });
    await expect(f.client.mutation(prepare, { externalId: anotherId, filename: "scan.pdf", mimeType: "application/pdf", byteSize: 6 * 1024 * 1024 })).rejects.toThrow("CHAT_ATTACHMENT_LIMIT");
  });

  it("prevents another owner or chat from claiming, resolving or deleting an attachment", async () => {
    const f = await fixture(), other = await user(f.t);
    const item = await ready(f.t, f.client, f.externalId);
    await expect(other.client.query(getFile, { attachmentId: item.attachmentId })).rejects.toThrow("CHAT_ATTACHMENT_UNAVAILABLE");
    await expect(other.client.mutation(remove, { attachmentId: item.attachmentId })).rejects.toThrow("CHAT_ATTACHMENT_UNAVAILABLE");
    const secondChat = crypto.randomUUID();
    await f.client.mutation(api.chats.ensure, { externalId: secondChat, jurisdictionId: f.jurisdictionId });
    await expect(f.client.query(resolve, { externalId: secondChat, attachmentIds: [item.attachmentId] })).rejects.toThrow("CHAT_ATTACHMENT_UNAVAILABLE");
    await expect(f.client.mutation(api.chats.appendMessages, { externalId: secondChat, lastMessage: "", messages: [userMessage(item.attachmentId)] })).rejects.toThrow("CHAT_ATTACHMENT_UNAVAILABLE");
  });

  it("rate limits preparation and raw uploads per owner even after drafts are removed", async () => {
    const f = await fixture();
    const now = Date.now(), window = Math.floor(now / (60 * 60_000));
    await f.t.run(ctx => ctx.db.insert("widgetRateBuckets", { namespace: "chat-attachment-prepare", key: f.userId, window, count: 60, expiresAt: (window + 1) * 60 * 60_000 }));
    await expect(f.client.mutation(prepare, { externalId: f.externalId, filename: "notes.txt", mimeType: "text/plain", byteSize: 5 })).rejects.toThrow("CHAT_ATTACHMENT_RATE_LIMITED");
    await f.t.run(async ctx => {
      const row = await ctx.db.query("widgetRateBuckets").withIndex("by_namespace_and_key_and_window", q => q.eq("namespace", "chat-attachment-prepare").eq("key", f.userId).eq("window", window)).unique();
      await ctx.db.patch(row!._id, { count: 59 });
    });
    const { attachmentId } = await f.client.mutation(prepare, { externalId: f.externalId, filename: "notes.txt", mimeType: "text/plain", byteSize: 5 });
    await f.t.run(ctx => ctx.db.insert("widgetRateBuckets", { namespace: "chat-attachment-upload", key: f.userId, window, count: 120, expiresAt: (window + 1) * 60 * 60_000 }));
    const response = await f.client.fetch("/chat-attachments/upload", { method: "POST", headers: { origin: "https://app.example.com", "x-attachment-id": attachmentId }, body: "hello" });
    expect(response.status).toBe(429);
    await f.client.mutation(remove, { attachmentId });
    expect(await f.client.mutation(remove, { attachmentId })).toEqual({ deleted: false });
    await expect(f.client.mutation(prepare, { externalId: f.externalId, filename: "notes.txt", mimeType: "text/plain", byteSize: 5 })).rejects.toThrow("CHAT_ATTACHMENT_RATE_LIMITED");
  });

  it("binds sent files once, returns safe message metadata and resolves saved files after reload", async () => {
    const f = await fixture(), item = await ready(f.t, f.client, f.externalId);
    const append = { externalId: f.externalId, lastMessage: "", messages: [userMessage(item.attachmentId)] };
    await f.client.mutation(api.chats.appendMessages, append);
    await f.client.mutation(api.chats.appendMessages, append);
    const page = await f.client.query(api.chats.listMessages, { externalId: f.externalId, paginationOpts: { numItems: 20, cursor: null } });
    expect(page.page).toHaveLength(1);
    expect(page.page[0].attachments).toEqual([{ id: item.attachmentId, filename: "notes.txt", mimeType: "text/plain", byteSize: 18, kind: "text" }]);
    expect(JSON.stringify(page)).not.toContain("storageId\":\"" + item.storageId);
    const context = await f.client.query(resolve, { externalId: f.externalId, attachmentIds: [] });
    expect(context.selectedJurisdiction.id).toBe(f.jurisdictionId);
    expect(context.attachments[0]).toMatchObject({ id: item.attachmentId, extractedText: "Private attachment" });
    await expect(f.client.mutation(remove, { attachmentId: item.attachmentId })).rejects.toThrow("CHAT_ATTACHMENT_ALREADY_SENT");
    await expect(f.client.mutation(api.chats.appendMessages, { ...append, messages: [userMessage(item.attachmentId, "another-message")] })).rejects.toThrow("CHAT_ATTACHMENT_ALREADY_SENT");
    await expect(f.client.mutation(api.chats.appendMessages, { ...append, messages: [{ ...userMessage(item.attachmentId), attachmentIds: [] }] })).rejects.toThrow("CHAT_CLIENT_ID_CONFLICT");
  });

  it("revokes file access when jurisdiction access changes and immediately on chat deletion", async () => {
    const f = await fixture(), item = await ready(f.t, f.client, f.externalId);
    await f.t.run(ctx => ctx.db.patch(f.jurisdictionId, { status: "archived" }));
    await expect(f.client.query(getFile, { attachmentId: item.attachmentId })).rejects.toThrow("CHAT_ATTACHMENT_UNAVAILABLE");
    await f.t.run(ctx => ctx.db.patch(f.jurisdictionId, { status: "enabled" }));
    await f.client.mutation(api.chats.remove, { externalId: f.externalId });
    await expect(f.client.query(getFile, { attachmentId: item.attachmentId })).rejects.toThrow("CHAT_ATTACHMENT_UNAVAILABLE");
    await f.t.mutation(cleanup, { sessionId: f.sessionId });
    expect(await f.t.run(ctx => ctx.storage.get(item.storageId))).toBeNull();
    expect(await f.t.run(ctx => ctx.db.get(item.attachmentId))).toBeNull();
    await expect(f.client.mutation(finalize, { attachmentId: item.attachmentId, storageId: item.storageId, mimeType: "text/plain", kind: "text", extractedText: "Private attachment" })).rejects.toThrow("CHAT_ATTACHMENT_UNAVAILABLE");
  });

  it("allows only the owner to delete retained files after jurisdiction access is revoked", async () => {
    const f = await fixture(), other = await user(f.t);
    const item = await ready(f.t, f.client, f.externalId);
    await f.client.mutation(api.chats.appendMessages, { externalId: f.externalId, lastMessage: "", messages: [userMessage(item.attachmentId)] });
    await f.t.run(ctx => ctx.db.patch(f.jurisdictionId, { status: "archived" }));
    await expect(f.client.query(getFile, { attachmentId: item.attachmentId })).rejects.toThrow("CHAT_ATTACHMENT_UNAVAILABLE");
    await expect(other.client.mutation(api.chats.remove, { externalId: f.externalId })).resolves.toEqual({ deleted: false });
    expect(await f.t.run(ctx => ctx.db.get(item.attachmentId))).not.toBeNull();
    await expect(f.client.mutation(api.chats.remove, { externalId: f.externalId })).resolves.toEqual({ deleted: true });
    await f.t.mutation(cleanup, { sessionId: f.sessionId });
    expect(await f.t.run(ctx => ctx.storage.get(item.storageId))).toBeNull();
    expect(await f.t.run(ctx => ctx.db.get(item.attachmentId))).toBeNull();
  });

  it("keeps one original when concurrent upload finalizations race and safely discards the losing blob", async () => {
    const f = await fixture();
    const { attachmentId } = await f.client.mutation(prepare, { externalId: f.externalId, filename: "notes.txt", mimeType: "text/plain", byteSize: 5 });
    const [first, retry] = await Promise.all([f.t.run(ctx => ctx.storage.store(new Blob(["hello"], { type: "text/plain" }))), f.t.run(ctx => ctx.storage.store(new Blob(["hello"], { type: "text/plain" })))]);
    await Promise.all([first, retry].map(storageId => f.client.mutation(finalize, { attachmentId, storageId, mimeType: "text/plain", kind: "text", extractedText: "hello" })));
    const discard = makeFunctionReference<"mutation">("chatAttachments:discardUnclaimedUpload");
    await Promise.all([first, retry].map(storageId => f.t.mutation(discard, { storageId })));
    const rows = await f.t.run(async ctx => ({ attachment: await ctx.db.get(attachmentId as Id<"chatAttachments">), blobs: await Promise.all([first, retry].map(id => ctx.db.system.get("_storage", id))) }));
    expect(rows.blobs.filter(Boolean)).toHaveLength(1);
    expect(rows.blobs.find(Boolean)?._id).toBe(rows.attachment?.storageId);
    const changed = await f.t.run(ctx => ctx.storage.store(new Blob(["other"], { type: "text/plain" })));
    await expect(f.client.mutation(finalize, { attachmentId, storageId: changed, mimeType: "text/plain", kind: "text", extractedText: "other" })).rejects.toThrow("CHAT_ATTACHMENT_UPLOAD_CONFLICT");
    await f.t.mutation(discard, { storageId: changed });
  });

  it("fails explicitly when saved attachment context exceeds its file or text budget", async () => {
    const f = await fixture(), item = await ready(f.t, f.client, f.externalId);
    await f.client.mutation(api.chats.appendMessages, { externalId: f.externalId, lastMessage: "", messages: [userMessage(item.attachmentId)] });
    await f.t.run(async ctx => {
      const row = (await ctx.db.get(item.attachmentId))!;
      for (let index = 0; index < 20; index++) await ctx.db.insert("chatAttachments", { sessionId: row.sessionId, userId: row.userId, filename: row.filename, mimeType: row.mimeType, byteSize: row.byteSize, kind: row.kind, status: "ready", storageId: row.storageId, extractedText: "facts", messageClientId: `seed-${index}`, createdAt: Date.now() });
    });
    await expect(f.client.query(resolve, { externalId: f.externalId, attachmentIds: [] })).rejects.toThrow("CHAT_ATTACHMENT_LIMIT");
    await f.t.run(async ctx => {
      const rows = await ctx.db.query("chatAttachments").withIndex("by_sessionId", q => q.eq("sessionId", f.sessionId)).take(25);
      for (const row of rows.slice(3)) await ctx.db.delete(row._id);
      for (const row of rows.slice(0, 3)) await ctx.db.patch(row._id, { extractedText: "x".repeat(100_000) });
    });
    await expect(f.client.query(resolve, { externalId: f.externalId, attachmentIds: [] })).rejects.toThrow("CHAT_ATTACHMENT_CONTEXT_LIMIT");
  });

  it("expires abandoned drafts and preserves bound files through retention after a day", async () => {
    vi.useFakeTimers();
    const f = await fixture(), draft = await ready(f.t, f.client, f.externalId), saved = await ready(f.t, f.client, f.externalId, "Saved");
    await f.client.mutation(api.chats.appendMessages, { externalId: f.externalId, lastMessage: "", messages: [userMessage(saved.attachmentId)] });
    vi.setSystemTime(Date.now() + ATTACHMENT_DRAFT_TTL_MS + 1);
    await f.t.mutation(expire, { attachmentId: draft.attachmentId });
    await f.t.mutation(expire, { attachmentId: saved.attachmentId });
    expect(await f.t.run(ctx => ctx.storage.get(draft.storageId))).toBeNull();
    await f.t.mutation(makeFunctionReference<"mutation">("admin/operations:runRetentionBatch"), { cursor: null });
    expect(await f.t.run(ctx => ctx.db.system.get("_storage", saved.storageId))).not.toBeNull();
    expect((await f.client.query(resolve, { externalId: f.externalId, attachmentIds: [] })).attachments).toHaveLength(1);
  });

  it("permits a signed document answer only with current verified attachment context and a bound claim", async () => {
    const f = await fixture(), item = await ready(f.t, f.client, f.externalId);
    const input = { routeNonce: createOpaqueTelemetryToken(), externalId: f.externalId, jurisdictionId: f.jurisdictionId, assistantClientId: "assistant-1", finalAnswer: "The file contains private notes.", answerKind: "document" as const, citations: [], model: "gemini-3-flash", elapsedMs: 100, outcome: "success" as const, authorizedScopeSize: 0, readyStoreCount: 0, partialCoverage: false, jurisdictionCoverage: [], attachmentIds: [item.attachmentId] };
    const serviceProof = await createTelemetryServiceProof(await completeGovernedInteractionProofParts(input));
    const result = await f.client.mutation(complete, { ...input, serviceProof });
    expect(result).toMatchObject({ status: "completed", answerKind: "document", citations: [] });
    await f.client.mutation(api.chats.appendMessages, { externalId: f.externalId, lastMessage: input.finalAnswer, messages: [userMessage(item.attachmentId), { role: "assistant", clientId: input.assistantClientId, content: input.finalAnswer, answerKind: "document", citations: [], citationClaim: result.citationClaim }] });
    const tampered = { ...input, routeNonce: createOpaqueTelemetryToken(), assistantClientId: "assistant-2", attachmentIds: [] };
    await expect(f.client.mutation(complete, { ...tampered, serviceProof: await createTelemetryServiceProof(await completeGovernedInteractionProofParts(tampered)) })).rejects.toThrow("INVALID_GOVERNED_INTERACTION");
    await expect(f.client.mutation(api.chats.appendMessages, { externalId: f.externalId, lastMessage: "forged", messages: [{ role: "assistant", clientId: "forged", content: "forged", answerKind: "document", citations: [] }] })).rejects.toThrow("INVALID_CHAT_CITATION_CLAIM");
  });

  it("binds attachment identities into the completion proof and checks them again before persistence", async () => {
    const f = await fixture(), first = await ready(f.t, f.client, f.externalId), second = await ready(f.t, f.client, f.externalId, "Other");
    const input = { routeNonce: createOpaqueTelemetryToken(), externalId: f.externalId, jurisdictionId: f.jurisdictionId, assistantClientId: "assistant", finalAnswer: "Summary", answerKind: "document" as const, citations: [], model: "gemini-3-flash", elapsedMs: 1, outcome: "success" as const, authorizedScopeSize: 0, readyStoreCount: 0, partialCoverage: false, jurisdictionCoverage: [], attachmentIds: [first.attachmentId] };
    const serviceProof = await createTelemetryServiceProof(await completeGovernedInteractionProofParts(input));
    await expect(f.client.mutation(complete, { ...input, attachmentIds: [second.attachmentId], serviceProof })).rejects.toThrow("GOVERNED_INTERACTION_SERVICE_PROOF_INVALID");
    const result = await f.client.mutation(complete, { ...input, serviceProof });
    await f.client.mutation(remove, { attachmentId: first.attachmentId });
    await expect(f.client.mutation(api.chats.appendMessages, { externalId: f.externalId, lastMessage: "Summary", messages: [{ role: "assistant", clientId: "assistant", content: "Summary", answerKind: "document", citations: [], citationClaim: result.citationClaim }] })).rejects.toThrow("CHAT_ATTACHMENT_UNAVAILABLE");
  });

  it("uploads raw bytes only for the configured origin and private bridges require a fresh service proof", async () => {
    const f = await fixture();
    const { attachmentId } = await f.client.mutation(prepare, { externalId: f.externalId, filename: "notes.txt", mimeType: "", byteSize: 5 });
    const headers = { origin: "https://app.example.com", "x-attachment-id": attachmentId, "content-type": "application/octet-stream" };
    expect((await f.client.fetch("/chat-attachments/upload", { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body: "hello" })).status).toBe(403);
    expect((await f.t.fetch("/chat-attachments/upload", { method: "POST", headers, body: "hello" })).status).toBe(401);
    const uploaded = await f.client.fetch("/chat-attachments/upload", { method: "POST", headers, body: "hello" });
    expect(uploaded.status).toBe(200);
    expect(await uploaded.json()).toMatchObject({ attachment: { id: attachmentId, mimeType: "text/plain", kind: "text" } });
    const body = JSON.stringify({ externalId: f.externalId, attachmentIds: [attachmentId] }), issuedAt = Date.now();
    expect((await f.client.fetch("/private/chat-attachments/resolve", { method: "POST", body })).status).toBe(401);
    const proof = await createChatAttachmentProof("resolve", body, issuedAt);
    const response = await f.client.fetch("/private/chat-attachments/resolve", { method: "POST", body, headers: { "x-file-issued-at": String(issuedAt), "x-file-proof": proof } });
    expect(response.status).toBe(200);
    expect((await response.json()).attachments[0]).toMatchObject({ id: attachmentId, extractedText: "hello" });
    const { attachmentId: corruptId } = await f.client.mutation(prepare, { externalId: f.externalId, filename: "fake.png", mimeType: "image/png", byteSize: 5 });
    const corrupt = await f.client.fetch("/chat-attachments/upload", { method: "POST", headers: { ...headers, "x-attachment-id": corruptId }, body: "hello" });
    expect(corrupt.status).toBe(400);
    expect(await f.t.run(async ctx => (await ctx.db.get(corruptId as Id<"chatAttachments">))?.storageId ?? null)).toBeNull();
  });
});
