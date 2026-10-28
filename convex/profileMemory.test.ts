/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import authSchema from "./betterAuth/schema";
import { scheduleProfileExtraction } from "./profileMemory";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("./betterAuth/**/*.ts")).map(
    ([path, load]) => [`./${path.slice("./betterAuth/".length)}`, load],
  ),
);
const DAY = 24 * 60 * 60 * 1000;

type T = TestConvex<typeof schema>;

function createTestBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function createClient(t: T) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "user", data: {
        name: "Memory test", email: `memory-${crypto.randomUUID()}@example.com`, emailVerified: true,
        createdAt: now, updatedAt: now, role: "user", banned: false, twoFactorEnabled: false,
      } },
    });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "session", data: {
        token: crypto.randomUUID(), userId: user._id, expiresAt: now + 90 * DAY, createdAt: now, updatedAt: now,
      } },
    });
    return { userId: user._id as string, sessionId: session._id };
  });
  return { userId, client: t.withIdentity({ subject: userId, sessionId }) };
}

async function createJurisdiction(t: T, organizationId?: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("jurisdictions", {
      name: organizationId ? "Acme policies" : "Ghana", slug: organizationId ? "acme" : "ghana",
      status: "enabled", isDefault: !organizationId, providerSyncState: "synced",
      kind: organizationId ? "organizational" : "geographic", visibility: organizationId ? "members" : "public",
      ...(organizationId ? { organizationId } : {}),
      createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
    });
  });
}

async function createOrganization(t: T, userId: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Acme", slug: `acme-${crypto.randomUUID()}`, class: "company", status: "active",
      createdBy: "fixture", updatedBy: "fixture", createdAt: now, updatedAt: now,
    });
    const membershipId = await ctx.db.insert("organizationMemberships", {
      organizationId, userId, status: "active", role: "member", createdAt: now, updatedAt: now,
    });
    return { organizationId, membershipId };
  });
}

async function createChat(t: T, userId: string, externalId: string, jurisdictionId: Id<"jurisdictions">) {
  return await t.run(async (ctx) => await ctx.db.insert("chatSessions", {
    userId, externalId, title: "Chat", lastMessage: "", messageCount: 0, updatedAt: Date.now(),
    jurisdictionId, jurisdictionName: "Ghana", jurisdictionKind: "geographic", jurisdictionContract: "unified",
  }));
}

async function ask(t: T, sessionId: Id<"chatSessions">, content: string) {
  return await t.run(async (ctx) => await ctx.db.insert("messages", {
    sessionId, role: "user", content, createdAt: Date.now(),
  }));
}

async function observe(
  t: T, messageId: Id<"messages">,
  observations: Array<{ type: "role" | "expertise" | "sector" | "topic" | "answer_preference"; value: string; kind: "stated" | "implied"; quote: string }>,
) {
  return await t.mutation(internal.profileMemory.recordObservations, { messageId, observations });
}

async function facts(t: T) {
  return await t.run(async (ctx) => await ctx.db.query("userProfileFacts").take(100));
}

describe("profile memory", () => {
  beforeEach(() => {
    vi.stubEnv("PROFILE_MEMORY_ENABLED", "true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("confirms a stated fact at once and uses it for answers", async () => {
    const t = createTestBackend();
    const { userId, client } = await createClient(t);
    const chat = await createChat(t, userId, "chat-1", await createJurisdiction(t));
    const message = await ask(t, chat, "I am a landlord in Accra. Can I raise the rent mid-year?");

    await expect(observe(t, message, [{ type: "role", value: "landlord", kind: "stated", quote: "I am a landlord" }]))
      .resolves.toEqual({ recorded: 1 });

    expect(await facts(t)).toMatchObject([{ type: "role", value: "landlord", status: "confirmed", source: "stated", quote: "I am a landlord" }]);
    await expect(client.query(api.profileMemory.forChat, { externalId: "chat-1" })).resolves.toEqual({ role: ["landlord"] });
  });

  it("ignores observations whose quote is not in the question or whose value is not in the catalogue", async () => {
    const t = createTestBackend();
    const { userId } = await createClient(t);
    const chat = await createChat(t, userId, "chat-1", await createJurisdiction(t));
    const message = await ask(t, chat, "Can a landlord raise the rent mid-year?");

    await expect(observe(t, message, [
      { type: "role", value: "landlord", kind: "stated", quote: "I am a landlord" },
      { type: "role", value: "astronaut", kind: "stated", quote: "landlord" },
      { type: "topic", value: "tenancy", kind: "stated", quote: "raise the rent" },
    ])).resolves.toEqual({ recorded: 0 });
    expect(await facts(t)).toEqual([]);
  });

  it("promotes an implied fact only after three sightings in two chats over a day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    const t = createTestBackend();
    const { userId, client } = await createClient(t);
    const jurisdictionId = await createJurisdiction(t);
    const first = await createChat(t, userId, "chat-1", jurisdictionId);
    const second = await createChat(t, userId, "chat-2", jurisdictionId);
    const implied = { type: "role" as const, value: "tenant", kind: "implied" as const, quote: "my landlord" };

    await observe(t, await ask(t, first, "my landlord kept my deposit, what can I do?"), [implied]);
    await observe(t, await ask(t, first, "my landlord changed the locks"), [implied]);
    expect((await facts(t))[0]).toMatchObject({ status: "candidate", sightings: 2, chatCount: 1 });

    // A third sighting in a second chat, but on the same day, is not enough.
    await observe(t, await ask(t, second, "my landlord wants me out by Friday"), [implied]);
    expect((await facts(t))[0]).toMatchObject({ status: "candidate", sightings: 3, chatCount: 2 });
    await expect(client.query(api.profileMemory.forChat, { externalId: "chat-2" })).resolves.toBeNull();

    vi.setSystemTime(1_000_000_000_000 + DAY + 1);
    await observe(t, await ask(t, second, "my landlord won't fix the roof"), [implied]);
    expect((await facts(t))[0]).toMatchObject({ status: "confirmed", sightings: 4 });
    await expect(client.query(api.profileMemory.forChat, { externalId: "chat-2" })).resolves.toEqual({ role: ["tenant"] });
  });

  it("never relearns a fact the person removed", async () => {
    const t = createTestBackend();
    const { userId, client } = await createClient(t);
    const chat = await createChat(t, userId, "chat-1", await createJurisdiction(t));
    const stated = { type: "role" as const, value: "employer", kind: "stated" as const, quote: "I run a company" };
    await observe(t, await ask(t, chat, "I run a company with ten staff. What leave do I owe?"), [stated]);
    const [fact] = await facts(t);

    await client.mutation(api.profileMemory.removeFact, { factId: fact._id });
    await observe(t, await ask(t, chat, "I run a company and need to dismiss someone"), [stated]);

    expect(await facts(t)).toMatchObject([{ status: "dismissed", sightings: 0 }]);
    await expect(t.run(async (ctx) => await ctx.db.query("userProfileEvidence").take(10))).resolves.toEqual([]);
    await expect(client.query(api.profileMemory.forChat, { externalId: "chat-1" })).resolves.toBeNull();

    // The person can still add it back themselves.
    await client.mutation(api.profileMemory.addFact, { type: "role", value: "employer" });
    await expect(client.query(api.profileMemory.forChat, { externalId: "chat-1" })).resolves.toEqual({ role: ["employer"] });
  });

  it("stops learning and answering with memory when paused or off for a chat", async () => {
    const t = createTestBackend();
    const { userId, client } = await createClient(t);
    const chat = await createChat(t, userId, "chat-1", await createJurisdiction(t));
    await client.mutation(api.profileMemory.addFact, { type: "expertise", value: "legal_professional" });

    await client.mutation(api.profileMemory.setEnabled, { enabled: false });
    await expect(client.query(api.profileMemory.forChat, { externalId: "chat-1" })).resolves.toBeNull();
    await expect(observe(t, await ask(t, chat, "I am a paralegal reviewing a lease"), [
      { type: "role", value: "paralegal", kind: "stated", quote: "I am a paralegal" },
    ])).resolves.toEqual({ recorded: 0 });

    await client.mutation(api.profileMemory.setEnabled, { enabled: true });
    await client.mutation(api.profileMemory.setChatMemory, { externalId: "chat-1", disabled: true });
    await expect(client.query(api.profileMemory.forChat, { externalId: "chat-1" })).resolves.toBeNull();
    await expect(client.query(api.profileMemory.chatMemory, { externalId: "chat-1" }))
      .resolves.toEqual({ available: true, enabled: true, disabledForChat: true });
  });

  it("is off for everyone unless the deployment turns it on", async () => {
    vi.stubEnv("PROFILE_MEMORY_ENABLED", "");
    const t = createTestBackend();
    const { userId, client } = await createClient(t);
    const chat = await createChat(t, userId, "chat-1", await createJurisdiction(t));
    await client.mutation(api.profileMemory.addFact, { type: "role", value: "tenant" });
    await expect(client.query(api.profileMemory.forChat, { externalId: "chat-1" })).resolves.toBeNull();
    const message = await ask(t, chat, "I am a tenant and my lease ends next month");
    await expect(observe(t, message, [{ type: "role", value: "tenant", kind: "stated", quote: "I am a tenant" }]))
      .resolves.toEqual({ recorded: 0 });
    await t.run(async (ctx) => {
      const session = (await ctx.db.get("chatSessions", chat))!;
      await scheduleProfileExtraction(ctx, { userId, session, messageId: message, question: "I am a tenant and my lease ends next month" });
    });
    await expect(t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").take(5))).resolves.toEqual([]);
  });

  it("schedules extraction only for questions long enough to be worth it", async () => {
    const t = createTestBackend();
    const { userId } = await createClient(t);
    const chat = await createChat(t, userId, "chat-1", await createJurisdiction(t));
    await t.run(async (ctx) => {
      const session = (await ctx.db.get("chatSessions", chat))!;
      const short = await ctx.db.insert("messages", { sessionId: chat, role: "user", content: "what about notice?", createdAt: 1 });
      await scheduleProfileExtraction(ctx, { userId, session, messageId: short, question: "what about notice?" });
      const long = await ctx.db.insert("messages", { sessionId: chat, role: "user", content: "I am a tenant and my lease ends next month", createdAt: 2 });
      await scheduleProfileExtraction(ctx, { userId, session, messageId: long, question: "I am a tenant and my lease ends next month" });
    });
    const scheduled = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").take(5));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toBe("profileMemoryActions:extract");
  });

  it("keeps an organization's profile separate and drops it when the person leaves", async () => {
    const t = createTestBackend();
    const { userId, client } = await createClient(t);
    const { organizationId, membershipId } = await createOrganization(t, userId);
    await createChat(t, userId, "personal", await createJurisdiction(t));
    const orgChat = await createChat(t, userId, "org", await createJurisdiction(t, organizationId));
    await client.mutation(api.profileMemory.addFact, { type: "answer_preference", value: "brief" });

    await observe(t, await ask(t, orgChat, "As our compliance officer I need the filing rules"), [
      { type: "role", value: "compliance_officer", kind: "stated", quote: "As our compliance officer" },
    ]);

    expect((await facts(t)).find((fact) => fact.type === "role")).toMatchObject({ scope: organizationId, organizationId });
    await expect(client.query(api.profileMemory.forChat, { externalId: "personal" })).resolves.toEqual({ answer_preference: ["brief"] });
    await expect(client.query(api.profileMemory.forChat, { externalId: "org" }))
      .resolves.toEqual({ answer_preference: ["brief"], role: ["compliance_officer"] });
    const overview = await client.query(api.profileMemory.overview, {});
    expect(overview?.scopes.map((scope) => [scope.name, scope.facts.length])).toEqual([["Personal", 1], ["Acme", 1]]);

    await t.run(async (ctx) => await ctx.db.patch(membershipId, { status: "inactive" }));
    await expect(client.query(api.profileMemory.forChat, { externalId: "org" })).resolves.toEqual({ answer_preference: ["brief"] });
  });

  it("lets a stated value replace a single-valued implied one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    const t = createTestBackend();
    const { userId, client } = await createClient(t);
    const chat = await createChat(t, userId, "chat-1", await createJurisdiction(t));
    await client.mutation(api.profileMemory.addFact, { type: "expertise", value: "general_public" });
    await observe(t, await ask(t, chat, "I'm a lawyer advising a client on a lease"), [
      { type: "expertise", value: "legal_professional", kind: "stated", quote: "I'm a lawyer" },
    ]);
    const rows = await facts(t);
    expect(rows.find((fact) => fact.value === "general_public")).toMatchObject({ status: "candidate" });
    expect(rows.find((fact) => fact.value === "legal_professional")).toMatchObject({ status: "confirmed" });
    await expect(client.query(api.profileMemory.forChat, { externalId: "chat-1" })).resolves.toEqual({ expertise: ["legal_professional"] });
  });

  it("forgets what a chat taught when the chat is deleted", async () => {
    vi.useFakeTimers();
    const t = createTestBackend();
    const { userId, client } = await createClient(t);
    const jurisdictionId = await createJurisdiction(t);
    const kept = await createChat(t, userId, "kept", jurisdictionId);
    const removed = await createChat(t, userId, "removed", jurisdictionId);
    await observe(t, await ask(t, removed, "I am a landlord with two flats to let"), [
      { type: "role", value: "landlord", kind: "stated", quote: "I am a landlord" },
    ]);
    await observe(t, await ask(t, kept, "my employer has not paid me for two months"), [
      { type: "role", value: "employee", kind: "implied", quote: "my employer" },
    ]);

    await client.mutation(api.chats.remove, { externalId: "removed" });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    expect((await facts(t)).map((fact) => fact.value)).toEqual(["employee"]);
  });

  it("expires stale candidates and demotes implied facts that stop showing up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    const t = createTestBackend();
    const { userId } = await createClient(t);
    const chat = await createChat(t, userId, "chat-1", await createJurisdiction(t));
    await observe(t, await ask(t, chat, "my employer cut my salary without notice"), [
      { type: "role", value: "employee", kind: "implied", quote: "my employer" },
    ]);
    await observe(t, await ask(t, chat, "I am a landlord with a tenant in arrears"), [
      { type: "role", value: "landlord", kind: "stated", quote: "I am a landlord" },
    ]);

    vi.setSystemTime(1_000_000_000_000 + 31 * DAY);
    await t.mutation(internal.profileMemory.decayBatch, {});
    expect((await facts(t)).map((fact) => [fact.value, fact.status])).toEqual([["landlord", "confirmed"]]);
  });

  it("deletes everything on clear all", async () => {
    vi.useFakeTimers();
    const t = createTestBackend();
    const { userId, client } = await createClient(t);
    const chat = await createChat(t, userId, "chat-1", await createJurisdiction(t));
    await observe(t, await ask(t, chat, "I am a landlord with two flats to let"), [
      { type: "role", value: "landlord", kind: "stated", quote: "I am a landlord" },
    ]);
    await client.mutation(api.profileMemory.clearAll, {});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await facts(t)).toEqual([]);
    await expect(t.run(async (ctx) => await ctx.db.query("userProfileEvidence").take(10))).resolves.toEqual([]);
  });
});
