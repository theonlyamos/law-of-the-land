/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import authSchema from "../betterAuth/schema";
import schema from "../schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [
    path.startsWith("../") ? `./${path.slice(3)}` : `./admin/${path.slice(2)}`,
    load,
  ]),
);
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("../betterAuth/**/*.ts")).map(([path, load]) => [
    `./${path.slice("../betterAuth/".length)}`,
    load,
  ]),
);
type Backend = TestConvex<typeof schema>;

const list = makeFunctionReference<"query">("admin/aiModels:list");
const set = makeFunctionReference<"mutation">("admin/aiModels:set");
const overrides = makeFunctionReference<"query">("aiModels:overrides");
const resolve = makeFunctionReference<"query">("aiModels:resolve");

function createBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function enablePanel(t: Backend) {
  process.env.ADMIN_PANEL_ENABLED = "true";
  process.env.ADMIN_ENVIRONMENT = "test";
  await t.run((ctx) => ctx.db.insert("featureFlags", {
    key: "admin_panel", environment: "test", enabled: true, updatedAt: Date.now(),
  }));
}

async function asAdmin(t: Backend, role = "super_admin") {
  const identity = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "user", data: {
        name: "AI model admin", email: `${crypto.randomUUID()}@example.com`, emailVerified: true,
        createdAt: now, updatedAt: now, role, banned: false, twoFactorEnabled: true,
      } },
    });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "session", data: {
        token: `session-${crypto.randomUUID()}`, userId: user._id, expiresAt: now + 60_000,
        createdAt: now, updatedAt: now, adminTwoFactorVerifiedAt: now,
      } },
    });
    return { userId: user._id, sessionId: session._id };
  });
  return { client: t.withIdentity({ subject: identity.userId, sessionId: identity.sessionId }), ...identity };
}

describe("AI model settings", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.ADMIN_PANEL_ENABLED;
    delete process.env.ADMIN_ENVIRONMENT;
  });

  it("falls back to Convex environment variables, then code defaults", async () => {
    vi.stubEnv("DOCUMENT_REVIEW_MODEL", "gemini-env-review");
    const t = createBackend();
    await expect(t.query(resolve, { feature: "document_review" })).resolves.toBe("gemini-env-review");
    await expect(t.query(resolve, { feature: "profile_memory" })).resolves.toBe("gemini-3.8-flash");
    await expect(t.query(resolve, { feature: "embedding" })).resolves.toBe("models/gemini-embedding-2");
    await expect(t.query(overrides, {})).resolves.toEqual({});
  });

  it("lets a super admin set, audit and clear a model", async () => {
    vi.stubEnv("DOCUMENT_REVIEW_MODEL", "gemini-env-review");
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t);

    await expect(admin.client.mutation(set, { feature: "document_review", model: "  gemini-custom-review " })).resolves.toBe("gemini-custom-review");
    await expect(t.query(resolve, { feature: "document_review" })).resolves.toBe("gemini-custom-review");
    await expect(t.query(overrides, {})).resolves.toEqual({ document_review: "gemini-custom-review" });
    const rows = await admin.client.query(list, {}) as Array<{ feature: string; model: string | null; convexEffectiveModel: string }>;
    expect(rows.map((row) => row.feature)).toEqual(["chat", "transcription", "document_review", "document_draft", "profile_memory", "source_verification", "intent_routing", "embedding"]);
    expect(rows.find((row) => row.feature === "document_review")).toMatchObject({ model: "gemini-custom-review", convexEffectiveModel: "gemini-custom-review" });

    await expect(admin.client.mutation(set, { feature: "document_review", model: null })).resolves.toBeNull();
    await expect(t.query(resolve, { feature: "document_review" })).resolves.toBe("gemini-env-review");

    const audits = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(audits.filter((event) => event.targetType === "aiModelSetting").map((event) => event.action)).toEqual(["ai_model.changed", "ai_model.reset"]);
  });

  it("adds the models/ prefix to embedding models and rejects malformed names", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await asAdmin(t);
    await expect(admin.client.mutation(set, { feature: "embedding", model: "gemini-embedding-3" })).resolves.toBe("models/gemini-embedding-3");
    await expect(admin.client.mutation(set, { feature: "chat", model: "models/gemini-x" })).resolves.toBe("gemini-x");
    await expect(admin.client.mutation(set, { feature: "chat", model: "bad model name" })).rejects.toThrow("not a valid model name");
    await expect(admin.client.mutation(set, { feature: "chat", model: "https://evil.example/x" })).rejects.toThrow("not a valid model name");
  });

  it("refuses admins without operations write", async () => {
    const t = createBackend();
    await enablePanel(t);
    const auditor = await asAdmin(t, "auditor");
    await expect(auditor.client.query(list, {})).resolves.toHaveLength(8);
    await expect(auditor.client.mutation(set, { feature: "chat", model: "gemini-x" })).rejects.toThrow();
    await expect(t.query(overrides, {})).resolves.toEqual({});
  });
});
