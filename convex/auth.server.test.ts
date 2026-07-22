// @vitest-environment node

import { memoryAdapter } from "@better-auth/memory-adapter";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { betterAuth } from "better-auth/minimal";
import { describe, expect, it } from "vitest";
import { createAuthOptions } from "./auth";

type MemoryRow = Record<string, unknown>;
type AuthHandler = {
  handler(request: Request): Promise<Response>;
};

function createServerAuthTest() {
  const options = createAuthOptions({} as never);
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
) {
  return await auth.handler(
    new Request(`http://localhost:3000/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
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
});
