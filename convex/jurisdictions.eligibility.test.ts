/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it } from "vitest";
import schema from "./schema";
import { researchManifestResolutionResponse } from "./http";
import { normalizeUniqueJurisdictionIds } from "./lib/jurisdictionDomain";
import {
  createResearchManifestHeaders,
  createResearchManifestNonce,
  RESEARCH_MANIFEST_HEADERS,
  RESEARCH_MANIFEST_REPLAY_WINDOW_MS,
} from "./lib/researchManifestProof";

const modules = import.meta.glob("./**/*.ts");
type Backend = TestConvex<typeof schema>;

const listPublicEnabled = makeFunctionReference<"query">(
  "jurisdictions:listPublicEnabled",
);
const getPublicByCode = makeFunctionReference<"query">(
  "jurisdictions:getPublicByCode",
);
const getResearchManifestAvailability = makeFunctionReference<"query">(
  "jurisdictions:getResearchManifestAvailability",
);
const invalidGeminiStores = [
  ["missing", null],
  ["empty", ""],
  ["malformed", "stores/ghana"],
  ["cross-resource", "fileSearchStores/UPPERCASE"],
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
  return convexTest(schema, modules);
}

async function insertJurisdiction(
  t: Backend,
  input: {
    code: string;
    name: string;
    slug: string;
    status: "draft" | "enabled";
    geminiFileSearchStoreName?: string | null;
    providerSyncState?: "pending" | "synced" | "drifted" | "failed";
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
      geminiFileSearchStoreName: input.geminiFileSearchStoreName === null
        ? undefined
        : input.geminiFileSearchStoreName ?? `fileSearchStores/${input.slug}`,
      providerSyncState: input.providerSyncState ?? "synced",
      createdBy: "fixture",
      updatedBy: "fixture",
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function signedResearchPost(
  t: Backend,
  pathname: "/internal/search-jurisdiction" | "/internal/search-jurisdictions",
  body: BodyInit | null,
  secret: string,
  options: {
    signedBody?: string;
    timestamp?: number;
    nonce?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const signedBody = options.signedBody ?? (typeof body === "string" ? body : "");
  const bodyBytes = new TextEncoder().encode(signedBody);
  const proofHeaders = bodyBytes.byteLength <= 1_024
    ? await createResearchManifestHeaders({
      secret,
      method: "POST",
      pathname,
      timestamp: options.timestamp ?? Date.now(),
      nonce: options.nonce ?? createResearchManifestNonce(),
      bodyBytes,
    })
    : {};
  const requestInit = {
    method: "POST",
    headers: { "content-type": "application/json", ...proofHeaders, ...options.headers },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
  } satisfies RequestInit & { duplex?: "half" };
  return await t.fetch(pathname, requestInit);
}

describe("research manifest request proof", () => {
  it("binds method, path, timestamp, nonce, and exact body bytes without sending the secret", async () => {
    const bodyBytes = new TextEncoder().encode('{"selectedJurisdictionId":"one","supplementaryJurisdictionIds":[]}');
    const headers = await createResearchManifestHeaders({
      secret: "research-manifest-secret-at-least-32-characters",
      method: "POST",
      pathname: "/internal/search-jurisdictions",
      timestamp: 1_700_000_000_000,
      nonce: createResearchManifestNonce(),
      bodyBytes,
    });
    expect(headers).toEqual({
      "x-research-manifest-version": "1",
      "x-research-manifest-timestamp": "1700000000000",
      "x-research-manifest-nonce": expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      "x-research-manifest-signature": expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(JSON.stringify(headers)).not.toContain("research-manifest-secret");
  });
});

async function insertPublishedDocument(
  t: Backend,
  jurisdictionId: Awaited<ReturnType<typeof insertJurisdiction>>,
  storeName: string,
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const resourceId = await ctx.db.insert("legalResources", {
      jurisdictionId,
      type: "act",
      title: "Trusted Act",
      issuer: "Parliament",
      officialCitation: "Act 7 of 2026",
      officialCitationKey: "act 7 of 2026",
      sourceUrl: "https://official.example/act-7",
      topics: ["employment"],
      effectiveDate: "2026-01-01",
      status: "active",
      createdBy: "fixture",
      updatedBy: "fixture",
      createdAt: now,
      updatedAt: now,
    });
    const originalStorageId = await ctx.storage.store(new Blob(["law"]));
    const versionId = await ctx.db.insert("documentVersions", {
      resourceId,
      versionNumber: 1,
      originalStorageId,
      filename: "act.pdf",
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "a".repeat(64),
      sourceUrl: "https://upload.example/untrusted",
      status: "published",
      geminiDocumentName: `${storeName}/documents/trusted-act-v1`,
      geminiIndexedAt: now,
      submittedBy: "fixture",
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(resourceId, { activeVersionId: versionId });
    return { resourceId, versionId };
  });
}

async function insertDraftDocument(
  t: Backend,
  jurisdictionId: Awaited<ReturnType<typeof insertJurisdiction>>,
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const resourceId = await ctx.db.insert("legalResources", {
      jurisdictionId,
      type: "act",
      title: "Draft Act",
      issuer: "Parliament",
      officialCitation: "Draft Act of 2026",
      officialCitationKey: "draft act of 2026",
      sourceUrl: "https://official.example/draft-act",
      topics: ["employment"],
      effectiveDate: "2026-06-01",
      status: "active",
      createdBy: "fixture",
      updatedBy: "fixture",
      createdAt: now,
      updatedAt: now,
    });
    const originalStorageId = await ctx.storage.store(new Blob(["draft"]));
    const versionId = await ctx.db.insert("documentVersions", {
      resourceId,
      versionNumber: 1,
      originalStorageId,
      filename: "draft-act.pdf",
      mimeType: "application/pdf",
      byteSize: 5,
      sha256: "b".repeat(64),
      sourceUrl: "https://upload.example/draft-act",
      status: "draft",
      submittedBy: "fixture",
      createdAt: now,
      updatedAt: now,
    });
    return { resourceId, versionId };
  });
}

describe("public jurisdiction eligibility", () => {
  it.each(invalidGeminiStores)(
    "excludes an enabled jurisdiction with a %s Gemini store",
    async (_label, geminiFileSearchStoreName) => {
      const t = createBackend();
      await insertJurisdiction(t, {
        code: "GH",
        name: "Ghana",
        slug: "ghana",
        status: "enabled",
        geminiFileSearchStoreName,
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
      isDefault: true,
    });
    await insertJurisdiction(t, {
      code: "GH",
      name: "Duplicate Ghana",
      slug: "duplicate-ghana",
      status: "enabled",
    });
    await insertJurisdiction(t, {
      code: "NG",
      name: "Nigeria",
      slug: "nigeria",
      status: "enabled",
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
      isDefault: true,
    });
    await insertJurisdiction(t, {
      code: "GH",
      name: "Draft Ghana",
      slug: "draft-ghana",
      status: "draft",
    });

    await expect(t.query(listPublicEnabled, {})).resolves.toEqual([
      { code: "GH", name: "Ghana", slug: "ghana", isDefault: true },
    ]);
    await expect(t.query(getPublicByCode, { code: "GH" })).resolves.toMatchObject({
      code: "GH",
      searchReady: true,
    });
  });
});

describe("internal search jurisdiction HTTP boundary", () => {
  const secret = "search-jurisdiction-test-secret-at-least-32-characters";

  async function post(t: Backend, body: string, suppliedSecret = secret) {
    return await signedResearchPost(t, "/internal/search-jurisdiction", body, suppliedSecret);
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
    });
    await insertJurisdiction(t, {
      code: "GH",
      name: "Duplicate Ghana",
      slug: "duplicate-ghana",
      status: "enabled",
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
      searchReady: true,
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
    signedBody?: string,
  ) {
    return await signedResearchPost(t, "/internal/search-jurisdictions", body, suppliedSecret, {
      headers,
      ...(signedBody === undefined ? {} : { signedBody }),
    });
  }

  async function reusableRequest(body: string, overrides: {
    pathname?: string;
    timestamp?: number;
    nonce?: string;
  } = {}) {
    const bodyBytes = new TextEncoder().encode(body);
    const headers = await createResearchManifestHeaders({
      secret,
      method: "POST",
      pathname: overrides.pathname ?? "/internal/search-jurisdictions",
      timestamp: overrides.timestamp ?? Date.now(),
      nonce: overrides.nonce ?? createResearchManifestNonce(),
      bodyBytes,
    });
    return { method: "POST", headers: { "content-type": "application/json", ...headers }, body } satisfies RequestInit;
  }

  it("rejects proofs with tampered method, path, body, signature, timestamp, or nonce", async () => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();
    const body = JSON.stringify({ selectedJurisdictionId: "opaque", supplementaryJurisdictionIds: [] });
    const original = await reusableRequest(body);
    const badSignature = { ...original, headers: { ...original.headers, [RESEARCH_MANIFEST_HEADERS.signature]: "A".repeat(43) } };
    const malformedNonce = { ...original, headers: { ...original.headers, [RESEARCH_MANIFEST_HEADERS.nonce]: "not-a-nonce" } };
    const tamperedBody = { ...original, body: `${body} ` };
    const wrongPath = await reusableRequest(body, { pathname: "/internal/search-jurisdiction" });
    const stale = await reusableRequest(body, { timestamp: Date.now() - RESEARCH_MANIFEST_REPLAY_WINDOW_MS - 1 });
    const future = await reusableRequest(body, { timestamp: Date.now() + RESEARCH_MANIFEST_REPLAY_WINDOW_MS + 1 });

    for (const init of [badSignature, malformedNonce, tamperedBody, wrongPath, stale, future]) {
      expect((await t.fetch("/internal/search-jurisdictions", init)).status).toBe(404);
    }
    expect((await t.fetch("/internal/search-jurisdictions", { ...original, method: "GET" })).status).toBe(404);
  });

  it("atomically rejects sequential and concurrent replay of a valid proof", async () => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();
    const selected = await insertJurisdiction(t, {
      code: "GH", name: "Ghana", slug: "ghana", status: "enabled",
    });
    const body = JSON.stringify({ selectedJurisdictionId: selected, supplementaryJurisdictionIds: [] });
    const sequential = await reusableRequest(body);
    expect((await t.fetch("/internal/search-jurisdictions", sequential)).status).toBe(200);
    expect((await t.fetch("/internal/search-jurisdictions", sequential)).status).toBe(404);

    const concurrent = await reusableRequest(body);
    const statuses = await Promise.all([
      t.fetch("/internal/search-jurisdictions", concurrent),
      t.fetch("/internal/search-jurisdictions", concurrent),
    ]).then((responses) => responses.map(({ status }) => status).sort());
    expect(statuses).toEqual([200, 404]);
  });

  it("returns canonical ready libraries in selected and supplementary request order", async () => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();
    const selected = await insertJurisdiction(t, {
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      status: "enabled",
    });
    const second = await insertJurisdiction(t, {
      code: "NG",
      name: "Nigeria",
      slug: "nigeria",
      status: "enabled",
    });
    const third = await insertJurisdiction(t, {
      code: "KE",
      name: "Kenya",
      slug: "kenya",
      status: "enabled",
    });

    await expect(t.query(getResearchManifestAvailability, {
      selectedJurisdictionId: selected,
      supplementaryJurisdictionIds: [third, second],
    })).resolves.toEqual({
      selected: { jurisdictionId: selected, status: "ready", storeName: "fileSearchStores/ghana", documents: [] },
      supplementary: [
        { jurisdictionId: third, status: "ready", storeName: "fileSearchStores/kenya", documents: [] },
        { jurisdictionId: second, status: "ready", storeName: "fileSearchStores/nigeria", documents: [] },
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
      selected: { jurisdictionId: selected, status: "ready", storeName: "fileSearchStores/ghana", documents: [] },
      supplementary: [
        { jurisdictionId: third, status: "ready", storeName: "fileSearchStores/kenya", documents: [] },
        { jurisdictionId: second, status: "ready", storeName: "fileSearchStores/nigeria", documents: [] },
      ],
    });
  });

  it("returns only the current active Convex citation manifest and rejects duplicate store ownership", async () => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();
    const storeName = "fileSearchStores/ghana";
    const selected = await insertJurisdiction(t, {
      code: "GH", name: "Ghana", slug: "ghana", status: "enabled", geminiFileSearchStoreName: storeName,
    });
    const { resourceId, versionId } = await insertPublishedDocument(t, selected, storeName);
    const response = await post(t, JSON.stringify({
      selectedJurisdictionId: selected,
      supplementaryJurisdictionIds: [],
    }));
    await expect(response.json()).resolves.toEqual({
      selected: {
        jurisdictionId: selected,
        status: "ready",
        storeName,
        documents: [{
          resourceId,
          versionId,
          documentName: `${storeName}/documents/trusted-act-v1`,
          title: "Trusted Act",
          officialCitation: "Act 7 of 2026",
          sourceUrl: "https://official.example/act-7",
        }],
      },
      supplementary: [],
    });

    await insertJurisdiction(t, {
      code: "NG", name: "Nigeria", slug: "nigeria", status: "enabled", geminiFileSearchStoreName: storeName,
    });
    const duplicate = await post(t, JSON.stringify({
      selectedJurisdictionId: selected,
      supplementaryJurisdictionIds: [],
    }));
    await expect(duplicate.json()).resolves.toEqual({
      selected: { jurisdictionId: selected, status: "needs_review" },
      supplementary: [],
    });
  });

  it("treats only non-null active-version pointers as publication claims", async () => {
    const t = createBackend();
    const storeName = "fileSearchStores/ghana";
    const selected = await insertJurisdiction(t, {
      code: "GH", name: "Ghana", slug: "ghana", status: "enabled", geminiFileSearchStoreName: storeName,
    });
    const published = await insertPublishedDocument(t, selected, storeName);
    const draft = await insertDraftDocument(t, selected);

    await expect(t.query(getResearchManifestAvailability, {
      selectedJurisdictionId: selected,
      supplementaryJurisdictionIds: [],
    })).resolves.toEqual({
      selected: {
        jurisdictionId: selected,
        status: "ready",
        storeName,
        documents: [{
          resourceId: published.resourceId,
          versionId: published.versionId,
          documentName: `${storeName}/documents/trusted-act-v1`,
          title: "Trusted Act",
          officialCitation: "Act 7 of 2026",
          sourceUrl: "https://official.example/act-7",
        }],
      },
      supplementary: [],
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(draft.resourceId, { activeVersionId: draft.versionId });
    });
    await expect(t.query(getResearchManifestAvailability, {
      selectedJurisdictionId: selected,
      supplementaryJurisdictionIds: [],
    })).resolves.toEqual({
      selected: { jurisdictionId: selected, status: "needs_review" },
      supplementary: [],
    });
  });

  it("pauses research while a document lifecycle operation can change store contents", async () => {
    const t = createBackend();
    const storeName = "fileSearchStores/ghana";
    const selected = await insertJurisdiction(t, {
      code: "GH", name: "Ghana", slug: "ghana", status: "enabled", geminiFileSearchStoreName: storeName,
    });
    const { resourceId, versionId } = await insertPublishedDocument(t, selected, storeName);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("documentLifecycleLocks", {
        resourceId,
        versionId,
        operation: "publish",
        actorId: "fixture",
        idempotencyKey: "fixture-lock",
        expiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(t.query(getResearchManifestAvailability, {
      selectedJurisdictionId: selected,
      supplementaryJurisdictionIds: [],
    })).resolves.toEqual({
      selected: { jurisdictionId: selected, status: "needs_review" },
      supplementary: [],
    });
  });

  it.each([
    ["missing", null, "synced", "unconfigured"],
    ["pending", "fileSearchStores/secret", "pending", "provisioning"],
    ["failed", "fileSearchStores/secret", "failed", "unconfigured"],
    ["drifted", "fileSearchStores/secret", "drifted", "needs_review"],
    ["malformed", "stores/secret", "synced", "needs_review"],
  ] as const)("classifies a %s selected store without leaking its value", async (_label, geminiFileSearchStoreName, providerSyncState, status) => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();
    const selected = await insertJurisdiction(t, {
      code: "GH",
      name: "SECRET_NAME",
      slug: "secret-slug",
      status: "enabled",
      geminiFileSearchStoreName,
      providerSyncState,
    });

    const response = await post(t, JSON.stringify({
      selectedJurisdictionId: selected,
      supplementaryJurisdictionIds: [],
    }));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      selected: { jurisdictionId: selected, status },
      supplementary: [],
    });
    expect(JSON.stringify(payload)).not.toMatch(/SECRET_NAME|secret-slug|legacy-secret|fileSearchStores|stores\/secret/);
  });

  it("keeps supplementary unconfigured entries in place while later entries retain order", async () => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();
    const selected = await insertJurisdiction(t, {
      code: "GH", name: "Ghana", slug: "ghana", status: "enabled",
    });
    const unavailable = await insertJurisdiction(t, {
      code: "NG", name: "Nigeria", slug: "nigeria", status: "enabled",
      geminiFileSearchStoreName: null,
    });
    const ready = await insertJurisdiction(t, {
      code: "KE", name: "Kenya", slug: "kenya", status: "enabled",
    });

    const response = await post(t, JSON.stringify({
      selectedJurisdictionId: selected,
      supplementaryJurisdictionIds: [unavailable, ready],
    }));
    await expect(response.json()).resolves.toEqual({
      selected: { jurisdictionId: selected, status: "ready", storeName: "fileSearchStores/ghana", documents: [] },
      supplementary: [
        { jurisdictionId: unavailable, status: "unconfigured" },
        { jurisdictionId: ready, status: "ready", storeName: "fileSearchStores/kenya", documents: [] },
      ],
    });
  });

  it("accepts the maximum one selected plus three supplementary IDs", async () => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();
    const ids = [];
    for (const [code, name] of [
      ["GH", "Ghana"],
      ["NG", "Nigeria"],
      ["KE", "Kenya"],
      ["ZA", "South Africa"],
    ] as const) {
      ids.push(await insertJurisdiction(t, {
        code,
        name,
        slug: name.toLowerCase().replaceAll(" ", "-"),
        status: "enabled",
      }));
    }
    const response = await post(t, JSON.stringify({
      selectedJurisdictionId: ids[0],
      supplementaryJurisdictionIds: ids.slice(1),
    }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.supplementary.map((item: { jurisdictionId: string }) => item.jurisdictionId))
      .toEqual(ids.slice(1));
  });

  it.each([
    ["empty body", ""],
    ["malformed JSON", "{"],
    ["unknown key", JSON.stringify({ selectedJurisdictionId: "x", supplementaryJurisdictionIds: [], extra: true })],
    ["client store", JSON.stringify({ selectedJurisdictionId: "x", supplementaryJurisdictionIds: [], storeName: "fileSearchStores/forged" })],
    ["client document", JSON.stringify({ selectedJurisdictionId: "x", supplementaryJurisdictionIds: [], documentName: "fileSearchStores/forged/documents/forged" })],
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
      code: "GH", name: "Ghana", slug: "ghana", status: "enabled",
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
    }), secret, { "content-length": "not-a-number" }, validBody);
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
      code: "GH", name: "Ghana", slug: "ghana", status: "enabled",
    });
    const disabled = await insertJurisdiction(t, {
      code: "NG", name: "Nigeria", slug: "nigeria", status: "draft",
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

  it("maps an unexpected internal query failure to a sanitized bodyless 500", async () => {
    const response = await researchManifestResolutionResponse(
      async () => {
        throw new Error("database transport secret detail");
      },
      { selectedJurisdictionId: "opaque", supplementaryJurisdictionIds: [] },
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("rejects raw-distinct IDs that normalize to the same jurisdiction", () => {
    expect(() => normalizeUniqueJurisdictionIds(
      ["canonical", "alternate-encoding"],
      () => "canonical" as never,
    )).toThrow("RESEARCH_MANIFEST_REQUEST_INVALID");
  });

  it("uniformly rejects missing selected or supplementary rows and a disabled selected row", async () => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;

    const missingSelectedBackend = createBackend();
    const missingSelected = await insertJurisdiction(missingSelectedBackend, {
      code: "GH", name: "Ghana", slug: "ghana", status: "enabled",
    });
    await missingSelectedBackend.run(async (ctx) => await ctx.db.delete(missingSelected));
    const missingSelectedResponse = await post(missingSelectedBackend, JSON.stringify({
      selectedJurisdictionId: missingSelected,
      supplementaryJurisdictionIds: [],
    }));
    expect(missingSelectedResponse.status).toBe(404);
    expect(await missingSelectedResponse.text()).toBe("");

    const missingSupplementaryBackend = createBackend();
    const selected = await insertJurisdiction(missingSupplementaryBackend, {
      code: "GH", name: "Ghana", slug: "ghana", status: "enabled",
    });
    const missingSupplementary = await insertJurisdiction(missingSupplementaryBackend, {
      code: "NG", name: "Nigeria", slug: "nigeria", status: "enabled",
    });
    await missingSupplementaryBackend.run(async (ctx) => await ctx.db.delete(missingSupplementary));
    const missingSupplementaryResponse = await post(missingSupplementaryBackend, JSON.stringify({
      selectedJurisdictionId: selected,
      supplementaryJurisdictionIds: [missingSupplementary],
    }));
    expect(missingSupplementaryResponse.status).toBe(404);
    expect(await missingSupplementaryResponse.text()).toBe("");

    const disabledBackend = createBackend();
    const disabled = await insertJurisdiction(disabledBackend, {
      code: "GH", name: "Ghana", slug: "ghana", status: "draft",
    });
    const disabledResponse = await post(disabledBackend, JSON.stringify({
      selectedJurisdictionId: disabled,
      supplementaryJurisdictionIds: [],
    }));
    expect(disabledResponse.status).toBe(404);
    expect(await disabledResponse.text()).toBe("");
  });

  it("stream-counts a valid body when content-length is the literal false value", async () => {
    process.env.SEARCH_JURISDICTION_SECRET = secret;
    const t = createBackend();
    const selected = await insertJurisdiction(t, {
      code: "GH", name: "Ghana", slug: "ghana", status: "enabled",
    });
    const response = await post(t, JSON.stringify({
      selectedJurisdictionId: selected,
      supplementaryJurisdictionIds: [],
    }), secret, { "content-length": "false" });
    expect(response.status).toBe(200);
  });
});
