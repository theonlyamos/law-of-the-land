/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it } from "vitest";
import { api, components } from "../_generated/api";
import authSchema from "../betterAuth/schema";
import schema from "../schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("../**/*.ts")).map(([path, load]) => [
    path.startsWith("../")
      ? `./${path.slice(3)}`
      : `./admin/${path.slice(2)}`,
    load,
  ]),
);
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("../betterAuth/**/*.ts")).map(
    ([path, load]) => [`./${path.slice("../betterAuth/".length)}`, load],
  ),
);

type Backend = TestConvex<typeof schema>;

function createBackend() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

async function createAdmin(t: Backend, role = "support_agent") {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: "Overview Admin",
          email: `overview-${crypto.randomUUID()}@example.com`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          role,
          banned: false,
          twoFactorEnabled: true,
        },
      },
    });
    const session = await ctx.runMutation(
      components.betterAuth.adapter.create,
      {
        input: {
          model: "session",
          data: {
            token: crypto.randomUUID(),
            userId: user._id,
            expiresAt: now + 60_000,
            createdAt: now,
            updatedAt: now,
            adminTwoFactorVerifiedAt: now,
          },
        },
      },
    );
    return { userId: user._id, sessionId: session._id };
  });
}

const previousAdminPanelEnabled = process.env.ADMIN_PANEL_ENABLED;
const previousAdminEnvironment = process.env.ADMIN_ENVIRONMENT;

afterEach(() => {
  if (previousAdminPanelEnabled === undefined) {
    delete process.env.ADMIN_PANEL_ENABLED;
  } else {
    process.env.ADMIN_PANEL_ENABLED = previousAdminPanelEnabled;
  }
  if (previousAdminEnvironment === undefined) {
    delete process.env.ADMIN_ENVIRONMENT;
  } else {
    process.env.ADMIN_ENVIRONMENT = previousAdminEnvironment;
  }
});

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

describe("admin overview", () => {
  it("does not expose the feature flag query to anonymous callers", async () => {
    const t = createBackend();
    await enablePanel(t);

    await expect(
      t.query(api.admin.featureFlags.isAdminEnabled, {}),
    ).rejects.toThrow("signed in");
  });

  it("returns the authoritative assured administrator before loading overview data", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await createAdmin(t, "support_agent");

    await expect(
      t
        .withIdentity({ subject: admin.userId, sessionId: admin.sessionId })
        .query(api.admin.overview.currentAdmin, {}),
    ).resolves.toEqual({ userId: admin.userId, roles: ["support_agent"] });
  });

  it("fails closed when the site-wide admin feature flag is disabled", async () => {
    const t = createBackend();
    process.env.ADMIN_PANEL_ENABLED = "false";
    process.env.ADMIN_ENVIRONMENT = "test";
    const admin = await createAdmin(t, "super_admin");

    await expect(
      t
        .withIdentity({ subject: admin.userId, sessionId: admin.sessionId })
        .query(api.admin.overview.currentAdmin, {}),
    ).rejects.toThrow("Administration is not enabled");
  });

  it("returns constant-shape counters and bounded empty queues for a new control plane", async () => {
    const t = createBackend();
    await enablePanel(t);
    const admin = await createAdmin(t, "super_admin");

    const result = await t
      .withIdentity({ subject: admin.userId, sessionId: admin.sessionId })
      .query(api.admin.overview.get, {});

    expect(result.counters.map((counter) => counter.key)).toEqual([
      "active_users",
      "questions_today",
      "review_backlog",
      "ingestion_failures",
    ]);
    expect(result.counters).toHaveLength(4);
    expect(result.failedJobs).toHaveLength(0);
    expect(result.reviewItems).toHaveLength(0);
    expect(result.highRiskEvents).toHaveLength(0);
  });
});
