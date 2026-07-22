import { describe, expect, it } from "vitest";
import { countRows } from "./betterAuth/countRows";
import schema from "./betterAuth/schema";

describe("local Better Auth schema", () => {
  it("contains user, session, and Two Factor tables", () => {
    expect(schema.tables.user).toBeDefined();
    expect(schema.tables.session).toBeDefined();
    expect(schema.tables.twoFactor).toBeDefined();
  });

  it("counts every row in a migration snapshot", async () => {
    async function* rows() {
      yield { id: 1 };
      yield { id: 2 };
      yield { id: 3 };
    }

    await expect(countRows(rows())).resolves.toBe(3);
  });
});
