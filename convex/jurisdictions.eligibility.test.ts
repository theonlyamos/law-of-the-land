/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it } from "vitest";
import { components } from "./_generated/api";
import authSchema from "./betterAuth/schema";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("./betterAuth/**/*.ts")).map(
    ([path, load]) => [`./${path.slice("./betterAuth/".length)}`, load],
  ),
);

type Backend = TestConvex<typeof schema>;

const listPublicEnabled = makeFunctionReference<"query">(
  "jurisdictions:listPublicEnabled",
);
const getPublicByCode = makeFunctionReference<"query">(
  "jurisdictions:getPublicByCode",
);
const getProductionLibraryAvailability = makeFunctionReference<"query">(
  "jurisdictions:getProductionLibraryAvailability",
);
const createJurisdiction = makeFunctionReference<"mutation">(
  "admin/resources:createJurisdiction",
);
const updateJurisdiction = makeFunctionReference<"mutation">(
  "admin/resources:updateJurisdiction",
);
const enableJurisdiction = makeFunctionReference<"mutation">(
  "admin/resources:enableJurisdiction",
);

const invalidProductionBuckets = [
  ["nonnumeric", "bucket-gh"],
  ["zero", "0"],
  ["negative", "-1"],
  ["unsafe integer", "9007199254740992"],
] as const;

const previousAdminPanelEnabled = process.env.ADMIN_PANEL_ENABLED;
const previousAdminEnvironment = process.env.ADMIN_ENVIRONMENT;
const previousSearchJurisdictionSecret = process.env.SEARCH_JURISDICTION_SECRET;

afterEach(() => {
  if (previousAdminPanelEnabled === undefined) delete process.env.ADMIN_PANEL_ENABLED;
  else process.env.ADMIN_PANEL_ENABLED = previousAdminPanelEnabled;
  if (previousAdminEnvironment === undefined) delete process.env.ADMIN_ENVIRONMENT;
  else process.env.ADMIN_ENVIRONMENT = previousAdminEnvironment;
  if (previousSearchJurisdictionSecret === undefined) {
    delete process.env.SEARCH_JURISDICTION_SECRET;
  } else {
    process.env.SEARCH_JURISDICTION_SECRET = previousSearchJurisdictionSecret;
  }
});

function createBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function enablePanel(t: Backend) {
  process.env.ADMIN_PANEL_ENABLED = "true";
  process.env.ADMIN_ENVIRONMENT = "test";
  await t.run(async (ctx) => {
    await ctx.db.insert("featureFlags", {
      key: "admin_panel",
      environment: "test",
      enabled: true,
      updatedAt: Date.now(),
    });
  });
}

async function asContentManager(t: Backend) {
  const identity = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: "Content manager fixture",
          email: `content-manager-${crypto.randomUUID()}@example.com`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          role: "content_manager",
          banned: false,
          twoFactorEnabled: true,
        },
      },
    });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          token: `session-${crypto.randomUUID()}`,
          userId: user._id,
          expiresAt: now + 60_000,
          createdAt: now,
          updatedAt: now,
          adminTwoFactorVerifiedAt: now,
        },
      },
    });
    return { userId: user._id, sessionId: session._id };
  });
  return t.withIdentity({ subject: identity.userId, sessionId: identity.sessionId });
}

async function insertJurisdiction(
  t: Backend,
  input: {
    code: string;
    name: string;
    slug: string;
    status: "draft" | "enabled";
    productionBucketId?: string;
    isDefault?: boolean;
  },
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("jurisdictions", {
      code: input.code,
      name: input.name,
      slug: input.slug,
      status: input.status,
      isDefault: input.isDefault ?? false,
      productionBucketId: input.productionBucketId,
      providerSyncState: "synced",
      createdBy: "fixture",
      updatedBy: "fixture",
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("public jurisdiction eligibility", () => {
  it.each(invalidProductionBuckets)(
    "excludes an enabled jurisdiction with a %s production bucket",
    async (_label, productionBucketId) => {
      const t = createBackend();
      await insertJurisdiction(t, {
        code: "GH",
        name: "Ghana",
        slug: "ghana",
        status: "enabled",
        productionBucketId,
        isDefault: true,
      });

      await expect(t.query(listPublicEnabled, {})).resolves.toEqual([]);
      await expect(t.query(getPublicByCode, { code: "GH" })).resolves.toBeNull();
    },
  );

  it("excludes every duplicate enabled code while retaining an unrelated eligible code", async () => {
    const t = createBackend();
    await insertJurisdiction(t, {
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      status: "enabled",
      productionBucketId: "11833",
      isDefault: true,
    });
    await insertJurisdiction(t, {
      code: "GH",
      name: "Duplicate Ghana",
      slug: "duplicate-ghana",
      status: "enabled",
      productionBucketId: "invalid",
    });
    await insertJurisdiction(t, {
      code: "NG",
      name: "Nigeria",
      slug: "nigeria",
      status: "enabled",
      productionBucketId: "22001",
    });

    await expect(t.query(listPublicEnabled, {})).resolves.toEqual([
      { code: "NG", name: "Nigeria", slug: "nigeria", isDefault: false },
    ]);
    await expect(t.query(getPublicByCode, { code: "GH" })).resolves.toBeNull();
  });

  it("retains a single eligible enabled code when another row is still a draft", async () => {
    const t = createBackend();
    await insertJurisdiction(t, {
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      status: "enabled",
      productionBucketId: "11833",
      isDefault: true,
    });
    await insertJurisdiction(t, {
      code: "GH",
      name: "Draft Ghana",
      slug: "draft-ghana",
      status: "draft",
      productionBucketId: "22001",
    });

    await expect(t.query(listPublicEnabled, {})).resolves.toEqual([
      { code: "GH", name: "Ghana", slug: "ghana", isDefault: true },
    ]);
    await expect(t.query(getPublicByCode, { code: "GH" })).resolves.toMatchObject({
      code: "GH",
      productionBucketId: "11833",
    });
  });
});

describe("admin production bucket boundaries", () => {
  it.each(invalidProductionBuckets)(
    "create rejects a %s production bucket",
    async (_label, productionBucketId) => {
      const t = createBackend();
      await enablePanel(t);
      const manager = await asContentManager(t);

      await expect(
        manager.mutation(createJurisdiction, {
          code: "GH",
          name: "Ghana",
          slug: "ghana",
          productionBucketId,
          isDefault: true,
          reason: "Create governed jurisdiction",
        }),
      ).rejects.toThrow("INVALID_PRODUCTION_BUCKET_ID");
    },
  );

  it("update cannot remove the production bucket from an enabled jurisdiction", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asContentManager(t);
    const id = await insertJurisdiction(t, {
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      status: "enabled",
      productionBucketId: "11833",
      isDefault: true,
    });

    await expect(
      manager.mutation(updateJurisdiction, {
        id,
        name: "Ghana",
        slug: "ghana",
        isDefault: true,
        reason: "Attempt to remove live provider configuration",
      }),
    ).rejects.toThrow("PRODUCTION_BUCKET_REQUIRED");
  });

  it.each(invalidProductionBuckets)(
    "update rejects a %s production bucket",
    async (_label, productionBucketId) => {
      const t = createBackend();
      await enablePanel(t);
      const manager = await asContentManager(t);
      const id = await insertJurisdiction(t, {
        code: "GH",
        name: "Ghana",
        slug: "ghana",
        status: "draft",
        productionBucketId: "11833",
        isDefault: true,
      });

      await expect(
        manager.mutation(updateJurisdiction, {
          id,
          name: "Ghana",
          slug: "ghana",
          productionBucketId,
          isDefault: true,
          reason: "Update governed jurisdiction",
        }),
      ).rejects.toThrow("INVALID_PRODUCTION_BUCKET_ID");
    },
  );

  it.each(invalidProductionBuckets)(
    "enable rejects a persisted %s production bucket",
    async (_label, productionBucketId) => {
      const t = createBackend();
      await enablePanel(t);
      const manager = await asContentManager(t);
      const id = await insertJurisdiction(t, {
        code: "GH",
        name: "Ghana",
        slug: "ghana",
        status: "draft",
        productionBucketId,
        isDefault: true,
      });

      await expect(
        manager.mutation(enableJurisdiction, {
          id,
          reason: "Enable governed jurisdiction",
        }),
      ).rejects.toThrow("INVALID_PRODUCTION_BUCKET_ID");
    },
  );
});

describe("internal search jurisdiction HTTP boundary", () => {
  const secret = "search-jurisdiction-test-secret-at-least-32-characters";

  async function post(t: Backend, body: string, suppliedSecret = secret) {
    return await t.fetch("/internal/search-jurisdiction", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-search-jurisdiction-secret": suppliedSecret,
      },
      body,
    });
  }

  it("fails closed for absent and incorrect transport secrets", async () => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();

    const absent = await t.fetch("/internal/search-jurisdiction", {
      method: "POST",
      body: JSON.stringify({ code: "GH" }),
    });
    const incorrect = await post(
      t,
      JSON.stringify({ code: "GH" }),
      "incorrect-search-jurisdiction-secret-at-least-32-characters",
    );

    expect(absent.status).toBe(404);
    expect(absent.headers.get("cache-control")).toBe("no-store");
    expect(incorrect.status).toBe(404);
    expect(incorrect.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["missing", ""],
    ["malformed JSON", "{"],
    ["invalid code", JSON.stringify({ code: "gh" })],
    ["oversized", "x".repeat(65)],
  ])("rejects a %s request body", async (_label, body) => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();

    const response = await post(t, body);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns private null responses for unknown and duplicate enabled codes", async () => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();
    await insertJurisdiction(t, {
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      status: "enabled",
      productionBucketId: "11833",
    });
    await insertJurisdiction(t, {
      code: "GH",
      name: "Duplicate Ghana",
      slug: "duplicate-ghana",
      status: "enabled",
      productionBucketId: "22001",
    });

    for (const code of ["ZZ", "GH"]) {
      const response = await post(t, JSON.stringify({ code }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      await expect(response.json()).resolves.toBeNull();
    }
  });

  it("keeps the public four-field DTO separate from the private search response", async () => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();
    await insertJurisdiction(t, {
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      status: "enabled",
      productionBucketId: "11833",
      isDefault: true,
    });

    await expect(t.query(listPublicEnabled, {})).resolves.toEqual([
      { code: "GH", name: "Ghana", slug: "ghana", isDefault: true },
    ]);
    const response = await post(t, JSON.stringify({ code: "GH" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      enabled: true,
      isDefault: true,
      productionBucketId: "11833",
    });
  });
});

describe("internal multi-jurisdiction library availability boundary", () => {
  const secret = "search-jurisdiction-test-secret-at-least-32-characters";

  async function post(
    t: Backend,
    body: BodyInit | null,
    suppliedSecret = secret,
    headers: Record<string, string> = {},
  ) {
    const requestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-search-jurisdiction-secret": suppliedSecret,
        ...headers,
      },
      body,
      ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
    } satisfies RequestInit & { duplex?: "half" };
    return await t.fetch("/internal/search-jurisdictions", requestInit);
  }

  it("returns canonical ready libraries in selected and supplementary request order", async () => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();
    const selected = await insertJurisdiction(t, {
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      status: "enabled",
      productionBucketId: " 0011833 ",
    });
    const second = await insertJurisdiction(t, {
      code: "NG",
      name: "Nigeria",
      slug: "nigeria",
      status: "enabled",
      productionBucketId: "22001",
    });
    const third = await insertJurisdiction(t, {
      code: "KE",
      name: "Kenya",
      slug: "kenya",
      status: "enabled",
      productionBucketId: "33001",
    });

    await expect(t.query(getProductionLibraryAvailability, {
      selectedJurisdictionId: selected,
      supplementaryJurisdictionIds: [third, second],
    })).resolves.toEqual({
      selected: { jurisdictionId: selected, status: "ready", productionBucketId: "0011833" },
      supplementary: [
        { jurisdictionId: third, status: "ready", productionBucketId: "33001" },
        { jurisdictionId: second, status: "ready", productionBucketId: "22001" },
      ],
    });

    const response = await post(t, JSON.stringify({
      selectedJurisdictionId: selected,
      supplementaryJurisdictionIds: [third, second],
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({
      selected: { jurisdictionId: selected, status: "ready", productionBucketId: "0011833" },
      supplementary: [
        { jurisdictionId: third, status: "ready", productionBucketId: "33001" },
        { jurisdictionId: second, status: "ready", productionBucketId: "22001" },
      ],
    });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["zero", "0"],
    ["negative", "-1"],
    ["decimal", "1.5"],
    ["non-digit", "bucket-1"],
    ["unsafe", "9007199254740992"],
  ])("classifies a %s selected bucket as unconfigured without leaking its value", async (_label, productionBucketId) => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();
    const selected = await insertJurisdiction(t, {
      code: "GH",
      name: "SECRET_NAME",
      slug: "secret-slug",
      status: "enabled",
      productionBucketId,
    });

    const response = await post(t, JSON.stringify({
      selectedJurisdictionId: selected,
      supplementaryJurisdictionIds: [],
    }));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      selected: { jurisdictionId: selected, status: "unconfigured" },
      supplementary: [],
    });
    expect(JSON.stringify(payload)).not.toMatch(/SECRET_NAME|secret-slug|bucket-|9007199254740992/);
  });

  it("keeps supplementary unconfigured entries in place while later entries retain order", async () => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();
    const selected = await insertJurisdiction(t, {
      code: "GH", name: "Ghana", slug: "ghana", status: "enabled", productionBucketId: "1",
    });
    const unavailable = await insertJurisdiction(t, {
      code: "NG", name: "Nigeria", slug: "nigeria", status: "enabled", productionBucketId: "0",
    });
    const ready = await insertJurisdiction(t, {
      code: "KE", name: "Kenya", slug: "kenya", status: "enabled", productionBucketId: "3",
    });

    const response = await post(t, JSON.stringify({
      selectedJurisdictionId: selected,
      supplementaryJurisdictionIds: [unavailable, ready],
    }));
    await expect(response.json()).resolves.toEqual({
      selected: { jurisdictionId: selected, status: "ready", productionBucketId: "1" },
      supplementary: [
        { jurisdictionId: unavailable, status: "unconfigured" },
        { jurisdictionId: ready, status: "ready", productionBucketId: "3" },
      ],
    });
  });

  it.each([
    ["empty body", ""],
    ["malformed JSON", "{"],
    ["unknown key", JSON.stringify({ selectedJurisdictionId: "x", supplementaryJurisdictionIds: [], extra: true })],
    ["empty selected", JSON.stringify({ selectedJurisdictionId: "", supplementaryJurisdictionIds: [] })],
    ["non-array supplementary", JSON.stringify({ selectedJurisdictionId: "x", supplementaryJurisdictionIds: "y" })],
    ["too many supplementary", JSON.stringify({ selectedJurisdictionId: "x", supplementaryJurisdictionIds: ["a", "b", "c", "d"] })],
    ["raw duplicate", JSON.stringify({ selectedJurisdictionId: "same", supplementaryJurisdictionIds: ["same"] })],
    ["overlong ID", JSON.stringify({ selectedJurisdictionId: "x".repeat(129), supplementaryJurisdictionIds: [] })],
    ["oversized body", "x".repeat(1_025)],
  ])("rejects %s as a bodyless bounded request error", async (_label, body) => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const response = await post(createBackend(), body);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("accepts a streamed request without content-length and rejects streamed overflow", async () => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();
    const selected = await insertJurisdiction(t, {
      code: "GH", name: "Ghana", slug: "ghana", status: "enabled", productionBucketId: "1",
    });
    const validBody = JSON.stringify({
      selectedJurisdictionId: selected,
      supplementaryJurisdictionIds: [],
    });
    const valid = await post(t, new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(validBody));
        controller.close();
      },
    }), secret, { "content-length": "not-a-number" });
    expect(valid.status).toBe(200);

    const oversized = await post(t, new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(1_025)));
        controller.close();
      },
    }));
    expect(oversized.status).toBe(400);
  });

  it("fails the whole request uniformly for malformed, missing, or disabled rows", async () => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();
    const selected = await insertJurisdiction(t, {
      code: "GH", name: "Ghana", slug: "ghana", status: "enabled", productionBucketId: "1",
    });
    const disabled = await insertJurisdiction(t, {
      code: "NG", name: "Nigeria", slug: "nigeria", status: "draft", productionBucketId: "2",
    });

    for (const supplementaryJurisdictionIds of [
      ["not-a-convex-id"],
      [disabled],
    ]) {
      const response = await post(t, JSON.stringify({
        selectedJurisdictionId: selected,
        supplementaryJurisdictionIds,
      }));
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
  });

  it("fails closed for missing and incorrect transport secrets", async () => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const body = JSON.stringify({
      selectedJurisdictionId: "opaque",
      supplementaryJurisdictionIds: [],
    });
    const t = createBackend();
    const absent = await t.fetch("/internal/search-jurisdictions", { method: "POST", body });
    const incorrect = await post(
      t,
      body,
      "incorrect-search-jurisdiction-secret-at-least-32-characters",
    );
    expect(absent.status).toBe(404);
    expect(incorrect.status).toBe(404);
    expect(await absent.text()).toBe("");
    expect(await incorrect.text()).toBe("");
  });
});
