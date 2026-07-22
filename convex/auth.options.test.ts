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
