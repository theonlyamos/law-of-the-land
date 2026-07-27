/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it } from "vitest";
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
  Object.entries(import.meta.glob("../betterAuth/**/*.ts")).map(
    ([path, load]) => [`./${path.slice("../betterAuth/".length)}`, load],
  ),
);

type Backend = TestConvex<typeof schema>;

const generateUploadUrl = makeFunctionReference<"mutation">(
  "admin/documents:generateUploadUrl",
);
const createDocumentVersion = makeFunctionReference<"mutation">(
  "admin/documents:createDocumentVersion",
);

function createBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function enablePanel(t: Backend) {
  process.env.ADMIN_PANEL_ENABLED = "true";
  process.env.ADMIN_ENVIRONMENT = "test";
  process.env.ADMIN_MAX_DOCUMENT_BYTES = "1000000";
  await t.run(async (ctx) => {
    await ctx.db.insert("featureFlags", {
      key: "admin_panel",
      environment: "test",
      enabled: true,
      updatedAt: Date.now(),
    });
  });
}

async function asAdmin(t: Backend, role: string) {
  const identity = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: `${role} fixture`,
          email: `${role}-${crypto.randomUUID()}@example.com`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          role,
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
  return {
    client: t.withIdentity({
      subject: identity.userId,
      sessionId: identity.sessionId,
    }),
    userId: identity.userId,
  };
}

async function seedResource(t: Backend, status: "active" | "archived" = "active") {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const jurisdictionId = await ctx.db.insert("jurisdictions", {
      code: "GH",
      name: "Ghana",
      slug: `ghana-${crypto.randomUUID()}`,
      status: "enabled",
      isDefault: false,
      stagingBucketId: "staging-gh",
      productionBucketId: "production-gh",
      providerSyncState: "synced",
      createdBy: "fixture",
      updatedBy: "fixture",
      createdAt: now,
      updatedAt: now,
    });
    const resourceId = await ctx.db.insert("legalResources", {
      jurisdictionId,
      type: "act",
      title: "Data Protection Act",
      issuer: "Parliament",
      officialCitation: "Act 843",
      officialCitationKey: "act 843",
      sourceUrl: "https://laws.example.gov/catalog/act-843",
      topics: ["privacy"],
      effectiveDate: "2012-10-16",
      status,
      createdBy: "fixture",
      updatedBy: "fixture",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("resourceVersionCounters", {
      resourceId,
      nextVersionNumber: 1,
      updatedAt: now,
    });
    return resourceId;
  });
}

async function storeFile(t: Backend, body = "abc", type = "application/pdf") {
  return await t.run(async (ctx) =>
    ctx.storage.store(new Blob([body], { type })),
  );
}

const originalAdminPanelEnabled = process.env.ADMIN_PANEL_ENABLED;
const originalAdminEnvironment = process.env.ADMIN_ENVIRONMENT;
const originalMaxBytes = process.env.ADMIN_MAX_DOCUMENT_BYTES;

afterEach(() => {
  if (originalAdminPanelEnabled === undefined) delete process.env.ADMIN_PANEL_ENABLED;
  else process.env.ADMIN_PANEL_ENABLED = originalAdminPanelEnabled;
  if (originalAdminEnvironment === undefined) delete process.env.ADMIN_ENVIRONMENT;
  else process.env.ADMIN_ENVIRONMENT = originalAdminEnvironment;
  if (originalMaxBytes === undefined) delete process.env.ADMIN_MAX_DOCUMENT_BYTES;
  else process.env.ADMIN_MAX_DOCUMENT_BYTES = originalMaxBytes;
});

describe("governed original-file uploads", () => {
  it("generates a direct storage URL only for an assured authorized admin and audits without the URL", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const auditor = await asAdmin(t, "auditor");

    await expect(auditor.client.mutation(generateUploadUrl, {})).rejects.toThrow(
      "ADMIN_FORBIDDEN",
    );
    const uploadUrl = await manager.client.mutation(generateUploadUrl, {});
    expect(uploadUrl).toMatch(/^https?:\/\//);
    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_action_and_createdAt", (q) =>
          q.eq("action", "document.upload_url_generated"),
        )
        .take(2),
    );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain(uploadUrl);

    await t.run(async (ctx) => {
      const flag = await ctx.db
        .query("featureFlags")
        .withIndex("by_key_and_environment", (q) =>
          q.eq("key", "admin_panel").eq("environment", "test"),
        )
        .unique();
      await ctx.db.patch(flag!._id, { enabled: false });
    });
    await expect(manager.client.mutation(generateUploadUrl, {})).rejects.toThrow(
      "ADMIN_DISABLED",
    );
  });

  it("creates the next immutable draft from verified storage metadata and writes a secret-safe audit", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const resourceId = await seedResource(t);
    const storageId = await storeFile(t);
    const sourceUrl = "https://laws.example.gov/files/act-843.pdf?official=1";

    const versionId = await manager.client.mutation(createDocumentVersion, {
      resourceId,
      storageId,
      filename: "Act-843.pdf",
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      sourceUrl,
      effectiveAt: "2012-10-16",
    });

    const state = await t.run(async (ctx) => ({
      version: await ctx.db.get("documentVersions", versionId as Id<"documentVersions">),
      counter: await ctx.db
        .query("resourceVersionCounters")
        .withIndex("by_resourceId", (q) => q.eq("resourceId", resourceId))
        .unique(),
      audits: await ctx.db
        .query("auditEvents")
        .withIndex("by_targetType_and_targetId", (q) =>
          q.eq("targetType", "documentVersion").eq("targetId", String(versionId)),
        )
        .take(2),
    }));
    expect(state.version).toMatchObject({
      resourceId,
      versionNumber: 1,
      originalStorageId: storageId,
      filename: "Act-843.pdf",
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      sourceUrl,
      effectiveDate: "2012-10-16",
      status: "draft",
      submittedBy: manager.userId,
    });
    expect(state.counter?.nextVersionNumber).toBe(2);
    expect(state.audits).toHaveLength(1);
    const serializedAudit = JSON.stringify(state.audits[0]);
    expect(serializedAudit).not.toContain("Act-843.pdf");
    expect(serializedAudit).not.toContain("laws.example.gov");
    expect(serializedAudit).not.toContain("ba7816");
    expect(serializedAudit).not.toContain(String(storageId));
  });

  it("rejects metadata that disagrees with the stored original", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const resourceId = await seedResource(t);
    const storageId = await storeFile(t);
    const valid = {
      resourceId,
      storageId,
      filename: "law.pdf",
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      sourceUrl: "https://laws.example.gov/files/law.pdf",
      effectiveAt: "2012-10-16",
    };

    await expect(
      manager.client.mutation(createDocumentVersion, {
        ...valid,
        filename: "law.exe",
      }),
    ).rejects.toThrow("UNSUPPORTED_DOCUMENT_TYPE");
    await expect(
      manager.client.mutation(createDocumentVersion, {
        ...valid,
        mimeType: "image/png",
      }),
    ).rejects.toThrow("DOCUMENT_MIME_MISMATCH");
    await expect(
      manager.client.mutation(createDocumentVersion, { ...valid, byteSize: 4 }),
    ).rejects.toThrow("DOCUMENT_SIZE_MISMATCH");
    await expect(
      manager.client.mutation(createDocumentVersion, {
        ...valid,
        sha256: "0".repeat(64),
      }),
    ).rejects.toThrow("DOCUMENT_CHECKSUM_MISMATCH");
  });

  it("rejects an unsafe source, invalid effective date, archived target, or missing size policy", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const resourceId = await seedResource(t);
    const archivedId = await seedResource(t, "archived");
    const storageId = await storeFile(t);
    const valid = {
      resourceId,
      storageId,
      filename: "law.pdf",
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      sourceUrl: "https://laws.example.gov/files/law.pdf",
      effectiveAt: "2012-10-16",
    };
    await expect(
      manager.client.mutation(createDocumentVersion, {
        ...valid,
        sourceUrl: "https://attacker.example/law.pdf",
      }),
    ).rejects.toThrow("DOCUMENT_SOURCE_NOT_ALLOWED");
    await expect(
      manager.client.mutation(createDocumentVersion, {
        ...valid,
        effectiveAt: "2026-02-31",
      }),
    ).rejects.toThrow("INVALID_EFFECTIVE_DATE");
    await expect(
      manager.client.mutation(createDocumentVersion, {
        ...valid,
        resourceId: archivedId,
      }),
    ).rejects.toThrow("RESOURCE_ARCHIVED");
    process.env.ADMIN_MAX_DOCUMENT_BYTES = "2";
    await expect(
      manager.client.mutation(createDocumentVersion, valid),
    ).rejects.toThrow("DOCUMENT_TOO_LARGE");
    delete process.env.ADMIN_MAX_DOCUMENT_BYTES;
    await expect(
      manager.client.mutation(createDocumentVersion, valid),
    ).rejects.toThrow("DOCUMENT_UPLOAD_NOT_CONFIGURED");
  });

  it("rejects a duplicate checksum in the same resource while permitting it in another resource", async () => {
    const t = createBackend();
    await enablePanel(t);
    const manager = await asAdmin(t, "content_manager");
    const resourceId = await seedResource(t);
    const otherResourceId = await seedResource(t);
    const firstStorageId = await storeFile(t);
    const secondStorageId = await storeFile(t);
    const thirdStorageId = await storeFile(t);
    const input = {
      resourceId,
      storageId: firstStorageId,
      filename: "law.pdf",
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      sourceUrl: "https://laws.example.gov/files/law.pdf",
      effectiveAt: "2012-10-16",
    };
    await manager.client.mutation(createDocumentVersion, input);
    await expect(
      manager.client.mutation(createDocumentVersion, {
        ...input,
        storageId: secondStorageId,
      }),
    ).rejects.toThrow("DUPLICATE_DOCUMENT_CHECKSUM");
    await expect(
      manager.client.mutation(createDocumentVersion, {
        ...input,
        resourceId: otherResourceId,
        storageId: thirdStorageId,
      }),
    ).resolves.toBeTruthy();
  });
});
