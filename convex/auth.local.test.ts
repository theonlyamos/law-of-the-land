import { describe, expect, it } from "vitest";
import { countRows } from "./betterAuth/countRows";
import schema from "./betterAuth/schema";

describe("local Better Auth schema", () => {
  it("contains Admin fields plus the session and Two Factor schema", () => {
    expect(schema.tables.user).toBeDefined();
    expect(schema.tables.session).toBeDefined();
    expect(schema.tables.twoFactor).toBeDefined();
    expect(schema.tables.user.validator.fields.role).toBeDefined();
    expect(schema.tables.user.validator.fields.banned).toBeDefined();
    expect(schema.tables.user.validator.fields.twoFactorEnabled).toBeDefined();
    expect(
      schema.tables.session.validator.fields.impersonatedBy,
    ).toBeDefined();
    expect(
      schema.tables.session.validator.fields.adminTwoFactorVerifiedAt,
    ).toBeDefined();
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
