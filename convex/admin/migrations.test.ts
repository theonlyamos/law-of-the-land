import { describe, expect, it } from "vitest";
import { verifyAuthMigrationSnapshot } from "./migrations";

const before = {
  component: "betterAuth" as const,
  counts: {
    user: 2,
    session: 3,
    account: 2,
    verification: 1,
  },
};

describe("Better Auth migration preservation gate", () => {
  it("accepts the same component and table counts", () => {
    expect(verifyAuthMigrationSnapshot(before, before)).toEqual(before);
  });

  it("rejects a component identity change", () => {
    expect(() =>
      verifyAuthMigrationSnapshot(before, {
        ...before,
        component: "differentComponent" as never,
      }),
    ).toThrow("Better Auth component identity changed");
  });

  it("rejects any table count change", () => {
    expect(() =>
      verifyAuthMigrationSnapshot(before, {
        ...before,
        counts: { ...before.counts, session: 0 },
      }),
    ).toThrow("Better Auth component data changed: session 3 -> 0");
  });
});
