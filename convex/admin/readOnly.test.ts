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

async function createAdmin(t: Backend, role: string) {
  const admin = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: `${role} administrator`,
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
    const session = await ctx.runMutation(
      components.betterAuth.adapter.create,
      {
        input: {
          model: "session",
          data: {
            token: `secret-${crypto.randomUUID()}`,
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
  return t.withIdentity({
    subject: admin.userId,
    sessionId: admin.sessionId,
  });
}

async function createUser(
  t: Backend,
  overrides: Partial<{
    name: string;
    email: string;
    role: string;
    banned: boolean;
    twoFactorEnabled: boolean;
  }> = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: overrides.name ?? "Case Reader",
          email: overrides.email ?? `reader-${crypto.randomUUID()}@example.com`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          role: overrides.role ?? "user",
          banned: overrides.banned ?? false,
          twoFactorEnabled: overrides.twoFactorEnabled ?? false,
        },
      },
    });
  });
}

const previousAdminPanelEnabled = process.env.ADMIN_PANEL_ENABLED;
const previousAdminEnvironment = process.env.ADMIN_ENVIRONMENT;
const previousGoogleAiApiKey = process.env.GOOGLE_AI_API_KEY;
const previousPolarOrganizationToken = process.env.POLAR_ORGANIZATION_TOKEN;

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
  if (previousGoogleAiApiKey === undefined) {
    delete process.env.GOOGLE_AI_API_KEY;
  } else {
    process.env.GOOGLE_AI_API_KEY = previousGoogleAiApiKey;
  }
  if (previousPolarOrganizationToken === undefined) {
    delete process.env.POLAR_ORGANIZATION_TOKEN;
  } else {
    process.env.POLAR_ORGANIZATION_TOKEN = previousPolarOrganizationToken;
  }
});

const firstPage = { paginationOpts: { numItems: 20, cursor: null } };

describe("read-only admin authorization", () => {
  it("denies billing managers from conversation metadata", async () => {
    const t = createBackend();
    await enablePanel(t);
    const asBilling = await createAdmin(t, "billing_manager");

    await expect(
      asBilling.query(api.admin.conversations.list, firstPage),
    ).rejects.toThrow("ADMIN_FORBIDDEN");
    await expect(
      asBilling.query(api.admin.users.listAllSessions, firstPage),
    ).rejects.toThrow("ADMIN_FORBIDDEN");
  });

  it("allows support agents to list conversation metadata", async () => {
    const t = createBackend();
    await enablePanel(t);
    const asSupport = await createAdmin(t, "support_agent");

    await expect(
      asSupport.query(api.admin.conversations.list, firstPage),
    ).resolves.toMatchObject({ page: expect.any(Array) });
  });

  it("allows auditors to read the minimized user directory", async () => {
    const t = createBackend();
    await enablePanel(t);
    const asAuditor = await createAdmin(t, "auditor");

    await expect(
      asAuditor.query(api.admin.users.list, firstPage),
    ).resolves.toMatchObject({ page: expect.any(Array) });
  });

  it("gates every read when the site-wide flag is disabled", async () => {
    const t = createBackend();
    await enablePanel(t);
    const asSuperAdmin = await createAdmin(t, "super_admin");
    process.env.ADMIN_PANEL_ENABLED = "false";

    await expect(
      asSuperAdmin.query(api.admin.users.list, firstPage),
    ).rejects.toThrow("ADMIN_DISABLED");
    await expect(
      asSuperAdmin.query(api.admin.users.listSessions, {
        ...firstPage,
        userId: "missing",
      }),
    ).rejects.toThrow("ADMIN_DISABLED");
    await expect(
      asSuperAdmin.query(api.admin.users.listAllSessions, firstPage),
    ).rejects.toThrow("ADMIN_DISABLED");
    await expect(
      asSuperAdmin.query(api.admin.conversations.list, firstPage),
    ).rejects.toThrow("ADMIN_DISABLED");
    await expect(
      asSuperAdmin.query(
        api.admin.operations.listIntegrationHealth,
        firstPage,
      ),
    ).rejects.toThrow("ADMIN_DISABLED");
  });
});

describe("read-only admin query behavior", () => {
  it("returns a site-wide session page with minimized user identity", async () => {
    const t = createBackend();
    await enablePanel(t);
    const asSupport = await createAdmin(t, "support_agent");
    const firstUser = await createUser(t, {
      name: "Ama Mensah",
      email: "ama@example.com",
    });
    const secondUser = await createUser(t, {
      name: "Kojo Owusu",
      email: "kojo@example.com",
    });
    const now = Date.now();

    await t.run(async (ctx) => {
      for (const [index, user] of [firstUser, secondUser].entries()) {
        await ctx.runMutation(components.betterAuth.adapter.create, {
          input: {
            model: "session",
            data: {
              token: `site-wide-secret-${index}`,
              userId: user._id,
              expiresAt: now + 60_000 + index,
              createdAt: now + index,
              updatedAt: now + index,
              ipAddress: `198.51.100.${index + 10}`,
              userAgent: `Private browser ${index}`,
            },
          },
        });
      }
    });

    const result = await asSupport.query(api.admin.users.listAllSessions, {
      paginationOpts: { numItems: 20, cursor: null },
    });

    expect(result.page).toHaveLength(3);
    expect(result.page.slice(0, 2).map((session) => session.userEmail)).toEqual([
      "kojo@example.com",
      "ama@example.com",
    ]);
    expect(result.page[0]).toMatchObject({
      userId: secondUser._id,
      userName: "Kojo Owusu",
      userEmail: "kojo@example.com",
      isImpersonated: false,
    });
    expect(Object.keys(result.page[0]).sort()).toEqual([
      "createdAt",
      "expiresAt",
      "id",
      "isImpersonated",
      "updatedAt",
      "userEmail",
      "userId",
      "userName",
    ]);
    expect(JSON.stringify(result)).not.toContain("site-wide-secret");
    expect(JSON.stringify(result)).not.toContain("198.51.100");
    expect(JSON.stringify(result)).not.toContain("Private browser");
  });

  it("uses exact normalized email and user ID lookup without leaking auth data", async () => {
    const t = createBackend();
    await enablePanel(t);
    const asAuditor = await createAdmin(t, "auditor");
    const target = await createUser(t, {
      name: "Ama Mensah",
      email: "ama.mensah@example.com",
      role: "support_agent",
      banned: true,
      twoFactorEnabled: true,
    });

    const byEmail = await asAuditor.query(api.admin.users.list, {
      ...firstPage,
      search: { kind: "email", value: "  AMA.MENSAH@EXAMPLE.COM  " },
    });
    const byId = await asAuditor.query(api.admin.users.list, {
      ...firstPage,
      search: { kind: "user_id", value: target._id },
    });

    expect(byEmail.page).toHaveLength(1);
    expect(byId.page).toHaveLength(1);
    expect(byEmail.page[0]).toEqual(byId.page[0]);
    expect(byEmail.page[0]).toMatchObject({
      id: target._id,
      name: "Ama Mensah",
      email: "ama.mensah@example.com",
      roles: ["support_agent"],
      banned: true,
      twoFactorEnabled: true,
    });
    expect(Object.keys(byEmail.page[0]).sort()).toEqual([
      "banned",
      "createdAt",
      "email",
      "emailVerified",
      "id",
      "name",
      "roles",
      "twoFactorEnabled",
      "updatedAt",
    ]);
    expect(JSON.stringify(byEmail)).not.toContain("secret-");
    expect(JSON.stringify(byEmail)).not.toContain("banReason");
  });

  it("returns only minimized session fields and never tokens or IP addresses", async () => {
    const t = createBackend();
    await enablePanel(t);
    const asSupport = await createAdmin(t, "support_agent");
    const target = await createUser(t);
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "session",
          data: {
            token: "raw-auth-token-must-not-leak",
            userId: target._id,
            expiresAt: now + 60_000,
            createdAt: now,
            updatedAt: now,
            ipAddress: "198.51.100.42",
            userAgent: "Sensitive exact browser fingerprint",
          },
        },
      });
    });

    const result = await asSupport.query(api.admin.users.listSessions, {
      ...firstPage,
      userId: target._id,
    });

    expect(result.page).toHaveLength(1);
    expect(Object.keys(result.page[0]).sort()).toEqual([
      "createdAt",
      "expiresAt",
      "id",
      "isImpersonated",
      "updatedAt",
      "userId",
    ]);
    expect(JSON.stringify(result)).not.toContain("raw-auth-token");
    expect(JSON.stringify(result)).not.toContain("198.51.100.42");
    expect(JSON.stringify(result)).not.toContain("fingerprint");
  });

  it("returns cursor-paginated conversation metadata without content-derived fields", async () => {
    const t = createBackend();
    await enablePanel(t);
    const asSupport = await createAdmin(t, "support_agent");

    await t.run(async (ctx) => {
      for (let index = 0; index < 3; index += 1) {
        await ctx.db.insert("chatSessions", {
          userId: "target-user",
          externalId: `external-${index}`,
          title: `Sensitive prompt title ${index}`,
          lastMessage: `Sensitive answer ${index}`,
          messageCount: index + 1,
          updatedAt: 1_900_000_000_000 + index,
          country: "GH",
        });
      }
    });

    const first = await asSupport.query(api.admin.conversations.list, {
      paginationOpts: { numItems: 2, cursor: null },
      userId: "target-user",
    });
    const second = await asSupport.query(api.admin.conversations.list, {
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
      userId: "target-user",
    });

    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    expect(second.page).toHaveLength(1);
    expect(first.page.map((row) => row.updatedAt)).toEqual([
      1_900_000_000_002,
      1_900_000_000_001,
    ]);
    expect(Object.keys(first.page[0]).sort()).toEqual([
      "country",
      "externalId",
      "id",
      "messageCount",
      "updatedAt",
      "userId",
    ]);
    expect(JSON.stringify(first)).not.toContain("Sensitive prompt");
    expect(JSON.stringify(first)).not.toContain("Sensitive answer");
  });

  it("returns bounded secret-free integration posture and rejects malformed filters", async () => {
    const t = createBackend();
    await enablePanel(t);
    const asAuditor = await createAdmin(t, "auditor");
    const asSupport = await createAdmin(t, "support_agent");
    process.env.GOOGLE_AI_API_KEY = "google-secret-value";
    process.env.POLAR_ORGANIZATION_TOKEN = "polar-secret-value";

    const health = await asAuditor.query(
      api.admin.operations.listIntegrationHealth,
      { paginationOpts: { numItems: 2, cursor: null } },
    );

    expect(health.page).toHaveLength(2);
    expect(health.isDone).toBe(false);
    expect(Object.keys(health.page[0]).sort()).toEqual([
      "configured",
      "id",
      "label",
      "status",
    ]);
    expect(JSON.stringify(health)).not.toContain("secret-value");

    const fullHealth = await asAuditor.query(
      api.admin.operations.listIntegrationHealth,
      { paginationOpts: { numItems: 20, cursor: null } },
    );
    expect(fullHealth.page.find((row) => row.id === "billing")).toMatchObject({
      configured: true,
      status: "configured",
    });
    expect(JSON.stringify(fullHealth)).not.toContain("polar-secret-value");
    expect(JSON.stringify(fullHealth)).not.toContain("google-secret-value");

    await expect(
      asAuditor.query(api.admin.users.list, {
        ...firstPage,
        search: { kind: "user_id", value: "   " },
      }),
    ).rejects.toThrow("INVALID_ADMIN_FILTER");
    await expect(
      asSupport.query(api.admin.conversations.list, {
        ...firstPage,
        userId: " target-user ",
      }),
    ).rejects.toThrow("INVALID_ADMIN_FILTER");
  });

  it("does not inherit the Google AI key from earlier integration coverage", () => {
    expect(process.env.GOOGLE_AI_API_KEY).toBe(previousGoogleAiApiKey);
  });
});
