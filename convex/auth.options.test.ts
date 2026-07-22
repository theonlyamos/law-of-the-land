import { describe, expect, it } from "vitest";
import { createAuth, createAuthOptions } from "./auth";

describe("Better Auth options", () => {
  it("preserves existing auth behavior and registers guarded admin plus Two Factor plugins", () => {
    const options = createAuthOptions({} as never);

    expect(options.emailAndPassword).toMatchObject({
      enabled: true,
      requireEmailVerification: true,
    });
    expect(options.emailVerification).toMatchObject({
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
    });
    expect(options.plugins?.map((plugin) => plugin.id)).toEqual([
      "admin",
      "two-factor",
      "convex",
    ]);
    expect(
      options.plugins?.find((plugin) => plugin.id === "two-factor")?.options,
    ).toMatchObject({ issuer: "Law of the Land Admin" });
  });

  it("persists input-disabled assurance only at successful Two Factor session boundaries", async () => {
    const options = createAuthOptions({} as never);
    expect(
      options.session?.additionalFields?.adminTwoFactorVerifiedAt,
    ).toMatchObject({ type: "date", required: false, input: false });

    const hook = options.databaseHooks?.session?.create?.before;
    expect(hook).toBeTypeOf("function");
    const session = {
      id: "session-id",
      token: "session-token",
      userId: "admin-id",
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };

    for (const path of [
      "/two-factor/verify-totp",
      "/two-factor/verify-backup-code",
    ]) {
      await expect(
        hook?.(session, { path } as never),
      ).resolves.toMatchObject({
        data: { adminTwoFactorVerifiedAt: expect.any(Date) },
      });
    }

    for (const path of [
      "/sign-in/email",
      "/verify-email",
      "/callback/:id",
    ]) {
      await expect(
        hook?.(session, {
          path,
          context: {
            internalAdapter: {
              findUserById: async () => ({ role: "user" }),
            },
          },
        } as never),
      ).resolves.not.toMatchObject({
        data: { adminTwoFactorVerifiedAt: expect.anything() },
      });
    }
  });

  it("blocks Better Auth's built-in role mutation route", async () => {
    const auth = createAuth({} as never);

    await expect(
      auth.api.setRole({
        body: { userId: "target-user", role: "super_admin" },
        headers: new Headers(),
      }),
    ).rejects.toThrow("Guarded admin mutation required");
  });
});
