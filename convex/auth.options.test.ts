import { describe, expect, it } from "vitest";
import { createAuthOptions } from "./auth";

describe("Better Auth options", () => {
  it("preserves existing auth behavior and declares the Two Factor schema", () => {
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
      "two-factor",
      "convex",
    ]);
  });
});
