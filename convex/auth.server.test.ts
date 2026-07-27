// @vitest-environment node

import { memoryAdapter } from "@better-auth/memory-adapter";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { betterAuth } from "better-auth/minimal";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it } from "vitest";
import { components } from "./_generated/api";
import { createAuthOptions } from "./auth";
import authSchema from "./betterAuth/schema";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const authModules = Object.fromEntries(
  Object.entries(import.meta.glob("./betterAuth/**/*.ts")).map(
    ([path, load]) => [`./${path.slice("./betterAuth/".length)}`, load],
  ),
);

type Backend = TestConvex<typeof schema>;

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

type MemoryRow = Record<string, unknown>;
type AuthHandler = {
  handler(request: Request): Promise<Response>;
};

function createServerAuthTest(ctx: object = {}) {
  const options = createAuthOptions(ctx as never);
  const { database: _database, emailVerification: _emailVerification, ...rest } =
    options;
  const db: Record<string, MemoryRow[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    twoFactor: [],
    jwks: [],
  };
  const auth = betterAuth({
    ...rest,
    baseURL: "http://localhost:3000",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    socialProviders: {},
    plugins: options.plugins?.filter((plugin) => plugin.id !== "convex"),
  });
  return { auth, db };
}

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

async function createComponentUser(t: Backend, role: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: "Cookie route fixture",
          email: `route-${crypto.randomUUID()}@example.com`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          role,
          banned: false,
          twoFactorEnabled: role !== "user",
        },
      },
    });
  });
}

async function createImpersonationBoundary() {
  const t = createBackend();
  await enablePanel(t);
  const actor = await createComponentUser(t, "super_admin");
  const target = await createComponentUser(t, "user");
  const session = await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          token: `route-session-${crypto.randomUUID()}`,
          userId: actor._id,
          expiresAt: now + 60_000,
          createdAt: now,
          updatedAt: now,
          adminTwoFactorVerifiedAt: now,
        },
      },
    });
  });
  const idempotencyKey = crypto.randomUUID();
  const operationId = await t.run(async (ctx) => {
    const now = Date.now();
    const correlationId = `op_${crypto.randomUUID().replaceAll("-", "")}`;
    return await ctx.db.insert("adminOperations", {
      actorId: actor._id,
      action: "impersonation_start",
      targetId: target._id,
      idempotencyKey,
      requestFingerprint: "{}",
      correlationId,
      status: "authorized",
      result: {
        status: "authorized",
        correlationId,
        action: "impersonation_start",
        targetId: target._id,
      },
      createdAt: now,
      updatedAt: now,
    });
  });
  const { auth, db } = createServerAuthTest({
    runMutation: async (reference: unknown, args: unknown) =>
      await (
        t as unknown as {
          mutation: (mutation: unknown, mutationArgs: unknown) => Promise<unknown>;
        }
      ).mutation(reference, args),
  });
  const actorCredentials = await signUp(auth);
  await signUp(auth);
  const routeActor = db.user[0];
  const routeTarget = db.user[1];
  const routeSession = db.session[0];
  if (!routeActor || !routeTarget || !routeSession) {
    throw new Error("Expected Better Auth route fixtures");
  }
  Object.assign(routeActor, {
    id: actor._id,
    role: "super_admin",
    twoFactorEnabled: true,
  });
  Object.assign(routeTarget, { id: target._id, role: "user" });
  Object.assign(routeSession, {
    id: session._id,
    userId: actor._id,
    adminTwoFactorVerifiedAt: new Date(),
  });
  return {
    actor,
    actorCredentials,
    auth,
    idempotencyKey,
    operationId,
    session,
    t,
    target,
  };
}

async function signUp(auth: AuthHandler) {
  const password = "test-password-123";
  const response = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Route Test",
        email: `${crypto.randomUUID()}@example.com`,
        password,
      }),
    }),
  );
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const tokenCookie = setCookie.match(/better-auth\.session_token=([^;]+)/)?.[1];
  expect(tokenCookie).toBeTruthy();
  return { cookie: `better-auth.session_token=${tokenCookie}`, password };
}

async function disableTwoFactor(
  auth: AuthHandler,
  cookie: string,
  password: string,
) {
  return await auth.handler(
    new Request("http://localhost:3000/api/auth/two-factor/disable", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ password }),
    }),
  );
}

async function postAuth(
  auth: AuthHandler,
  path: string,
  cookie: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  return await auth.handler(
    new Request(`http://localhost:3000/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, ...extraHeaders },
      body: JSON.stringify(body),
    }),
  );
}

describe("Better Auth administrative Two Factor policy", () => {
  it("persists assurance only after a successful real TOTP verification", async () => {
    const { auth, db } = createServerAuthTest();
    const credentials = await signUp(auth);
    expect(db.session).toHaveLength(1);
    expect(db.session[0]?.adminTwoFactorVerifiedAt).toBeUndefined();

    const enableResponse = await postAuth(
      auth,
      "/two-factor/enable",
      credentials.cookie,
      { password: credentials.password },
    );
    expect(enableResponse.status).toBe(200);
    const enableBody = (await enableResponse.json()) as { totpURI: string };
    const secret = new URL(enableBody.totpURI).searchParams.get("secret");
    expect(secret).toBeTruthy();
    if (!secret) return;
    const decodedSecret = new TextDecoder().decode(base32.decode(secret));
    const currentCode = await createOTP(decodedSecret).totp();
    const invalidCode = currentCode === "000000" ? "000001" : "000000";

    const invalidResponse = await postAuth(
      auth,
      "/two-factor/verify-totp",
      credentials.cookie,
      { code: invalidCode },
    );
    expect(invalidResponse.status).toBe(401);
    expect(db.session[0]?.adminTwoFactorVerifiedAt).toBeUndefined();

    const code = await createOTP(decodedSecret).totp();
    const verifyResponse = await postAuth(
      auth,
      "/two-factor/verify-totp",
      credentials.cookie,
      { code },
    );
    const verifyBody = await verifyResponse.clone().json();
    expect(verifyResponse.status, JSON.stringify(verifyBody)).toBe(200);
    expect(db.session).toHaveLength(1);
    expect(db.session[0]?.adminTwoFactorVerifiedAt).toBeInstanceOf(Date);
  });

  it("blocks the direct disable route for a current administrator", async () => {
    const { auth, db } = createServerAuthTest();
    const credentials = await signUp(auth);
    const user = db.user?.[0];
    expect(user).toBeDefined();
    if (!user) return;
    user.role = "super_admin";
    user.twoFactorEnabled = true;

    const response = await disableTwoFactor(
      auth,
      credentials.cookie,
      credentials.password,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      message: "Administrators cannot disable Two Factor",
    });
  });

  it("keeps the direct disable route available to a non-admin user", async () => {
    const { auth, db } = createServerAuthTest();
    const credentials = await signUp(auth);
    const user = db.user?.[0];
    expect(user).toBeDefined();
    if (!user) return;
    user.twoFactorEnabled = true;

    const response = await disableTwoFactor(
      auth,
      credentials.cookie,
      credentials.password,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: true });
  });

  it("issues an exact action-bound proof only after password verification succeeds", async () => {
    const issued: unknown[] = [];
    const { auth } = createServerAuthTest({
      runMutation: async (_reference: unknown, args: unknown) => {
        issued.push(args);
        return null;
      },
    });
    const credentials = await signUp(auth);
    const scope = {
      action: "roles_assign",
      target: "target-user",
      key: crypto.randomUUID(),
    };

    const rejected = await postAuth(
      auth,
      "/verify-password",
      credentials.cookie,
      { password: "incorrect-password" },
      {
        "x-admin-step-up-action": scope.action,
        "x-admin-step-up-target": scope.target,
        "x-admin-step-up-key": scope.key,
      },
    );
    expect(rejected.status).toBe(400);
    expect(issued).toEqual([]);

    const accepted = await postAuth(
      auth,
      "/verify-password",
      credentials.cookie,
      { password: credentials.password },
      {
        "x-admin-step-up-action": scope.action,
        "x-admin-step-up-target": scope.target,
        "x-admin-step-up-key": scope.key,
      },
    );
    expect(accepted.status).toBe(200);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      action: scope.action,
      targetId: scope.target,
      idempotencyKey: scope.key,
    });
    expect(JSON.stringify(issued)).not.toContain(credentials.password);
  });

  it("forwards a conversation export grant scope only after password verification", async () => {
    const issued: unknown[] = [];
    const { auth } = createServerAuthTest({
      runMutation: async (_reference: unknown, args: unknown) => {
        issued.push(args);
        return null;
      },
    });
    const credentials = await signUp(auth);
    const scope = {
      action: "conversation_export",
      target: "chat_42:grant_42",
      key: crypto.randomUUID(),
    };

    const accepted = await postAuth(
      auth,
      "/verify-password",
      credentials.cookie,
      { password: credentials.password },
      {
        "x-admin-step-up-action": scope.action,
        "x-admin-step-up-target": scope.target,
        "x-admin-step-up-key": scope.key,
      },
    );

    expect(accepted.status).toBe(200);
    expect(issued).toEqual([
      expect.objectContaining({
        action: scope.action,
        targetId: scope.target,
        idempotencyKey: scope.key,
      }),
    ]);
    expect(JSON.stringify(issued)).not.toContain(credentials.password);
  });

  it.each([
    ["legitimate cookie session", 200],
    ["actor without impersonate permission", 403],
    ["disabled feature", 403],
    ["impersonated session", 403],
    ["stale session", 403],
    ["administrator target", 403],
    ["missing actor", 403],
    ["banned actor", 403],
  ] as const)(
    "rechecks the production impersonation boundary for a %s",
    async (boundaryState, expectedStatus) => {
      const boundary = await createImpersonationBoundary();

      if (boundaryState === "actor without impersonate permission") {
        await boundary.t.run((ctx) =>
          ctx.runMutation(components.betterAuth.adapter.updateOne, {
            input: {
              model: "user",
              where: [
                { field: "_id", operator: "eq", value: boundary.actor._id },
              ],
              update: { role: "support_agent" },
            },
          }),
        );
      } else if (boundaryState === "disabled feature") {
        process.env.ADMIN_PANEL_ENABLED = "false";
      } else if (boundaryState === "impersonated session") {
        await boundary.t.run((ctx) =>
          ctx.runMutation(components.betterAuth.adapter.updateOne, {
            input: {
              model: "session",
              where: [
                {
                  field: "_id",
                  operator: "eq",
                  value: boundary.session._id,
                },
              ],
              update: { impersonatedBy: "original-admin" },
            },
          }),
        );
      } else if (boundaryState === "stale session") {
        await boundary.t.run((ctx) =>
          ctx.runMutation(components.betterAuth.adapter.updateOne, {
            input: {
              model: "session",
              where: [
                {
                  field: "_id",
                  operator: "eq",
                  value: boundary.session._id,
                },
              ],
              update: { expiresAt: 0 },
            },
          }),
        );
      } else if (boundaryState === "administrator target") {
        await boundary.t.run((ctx) =>
          ctx.runMutation(components.betterAuth.adapter.updateOne, {
            input: {
              model: "user",
              where: [
                { field: "_id", operator: "eq", value: boundary.target._id },
              ],
              update: { role: "content_manager" },
            },
          }),
        );
      } else if (boundaryState === "missing actor") {
        await boundary.t.run((ctx) =>
          ctx.runMutation(components.betterAuth.adapter.deleteOne, {
            input: {
              model: "user",
              where: [
                { field: "_id", operator: "eq", value: boundary.actor._id },
              ],
            },
          }),
        );
      } else if (boundaryState === "banned actor") {
        await boundary.t.run((ctx) =>
          ctx.runMutation(components.betterAuth.adapter.updateOne, {
            input: {
              model: "user",
              where: [
                { field: "_id", operator: "eq", value: boundary.actor._id },
              ],
              update: { banned: true },
            },
          }),
        );
      }

      const response = await postAuth(
        boundary.auth,
        "/admin/impersonate-user",
        boundary.actorCredentials.cookie,
        { userId: boundary.target._id },
        { "x-admin-operation-key": boundary.idempotencyKey },
      );

      expect(response.status).toBe(expectedStatus);
      await expect(
        boundary.t.run((ctx) => ctx.db.get(boundary.operationId)),
      ).resolves.toMatchObject({
        status: expectedStatus === 200 ? "succeeded" : "failed",
      });
    },
  );
});
