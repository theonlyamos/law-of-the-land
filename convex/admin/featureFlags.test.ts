/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it } from "vitest";
import { readUnifiedJurisdictionsEnabled } from "./featureFlags";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const previousEnvironment = process.env.ADMIN_ENVIRONMENT;

afterEach(() => {
  if (previousEnvironment === undefined) delete process.env.ADMIN_ENVIRONMENT;
  else process.env.ADMIN_ENVIRONMENT = previousEnvironment;
});

describe("unified jurisdictions feature flag", () => {
  it("fails closed when the unified-jurisdictions flag is absent or duplicated", async () => {
    process.env.ADMIN_ENVIRONMENT = "test";
    const t = convexTest(schema, modules);

    await expect(
      t.run((ctx) => readUnifiedJurisdictionsEnabled(ctx)),
    ).resolves.toBe(false);

    await t.run(async (ctx) => {
      await ctx.db.insert("featureFlags", {
        key: "unified_jurisdictions",
        environment: "test",
        enabled: true,
        updatedAt: 1,
      });
      await ctx.db.insert("featureFlags", {
        key: "unified_jurisdictions",
        environment: "test",
        enabled: true,
        updatedAt: 2,
      });
    });

    await expect(
      t.run((ctx) => readUnifiedJurisdictionsEnabled(ctx)),
    ).resolves.toBe(false);
  });

  it("fails closed when the selected unified-jurisdictions flag is disabled", async () => {
    process.env.ADMIN_ENVIRONMENT = "test";
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("featureFlags", {
      key: "unified_jurisdictions",
      environment: "test",
      enabled: false,
      updatedAt: 1,
    }));

    await expect(
      t.run((ctx) => readUnifiedJurisdictionsEnabled(ctx)),
    ).resolves.toBe(false);
  });
});
