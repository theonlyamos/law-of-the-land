/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import {
  assertGeographicLevel,
  normalizePlaceId,
} from "./lib/jurisdictionDomain";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("unified jurisdiction domain transition", () => {
  it("rejects an unsupported geographic level and an invalid Place ID", () => {
    expect(() => assertGeographicLevel("village")).toThrow("INVALID_GEOGRAPHIC_LEVEL");
    expect(() => normalizePlaceId(" ")).toThrow("INVALID_GOOGLE_PLACE_ID");
  });

  it("accepts an existing country-only row during the additive transition", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run(async (ctx) => ctx.db.insert("jurisdictions", {
      code: "GH",
      name: "Ghana",
      slug: "ghana",
      status: "enabled",
      isDefault: true,
      geminiFileSearchStoreName: "fileSearchStores/ghana",
      geminiEmbeddingModel: "models/gemini-embedding-2",
      providerSyncState: "synced",
      createdBy: "system",
      updatedBy: "system",
      createdAt: 1,
      updatedAt: 1,
    }));

    expect(id).toBeDefined();
  });

  it("accepts a new organizational row without a legacy country code", async () => {
    const t = convexTest(schema, modules);
    const organizationId = await t.run((ctx) => ctx.db.insert("organizations", {
      name: "Example University",
      slug: "example-university",
      class: "university",
      status: "active",
      createdBy: "system",
      updatedBy: "system",
      createdAt: 1,
      updatedAt: 1,
    }));
    const id = await t.run((ctx) => ctx.db.insert("jurisdictions", {
      name: "Example University Rules",
      slug: "example-university-rules",
      status: "enabled",
      isDefault: false,
      providerSyncState: "synced",
      kind: "organizational",
      visibility: "members",
      organizationId,
      createdBy: "system",
      updatedBy: "system",
      createdAt: 1,
      updatedAt: 1,
    }));

    expect(id).toBeDefined();
  });

});
