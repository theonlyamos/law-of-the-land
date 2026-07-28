import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const bootstrap = readFileSync(
  resolve(process.cwd(), "docs/admin/bootstrap.md"),
  "utf8",
);

describe("admin bootstrap documentation", () => {
  it("keeps the required Bun bootstrap commands in release order", () => {
    const requiredSequence = [
      "bun install --frozen-lockfile",
      "$ApprovedIsolatedDeployment = $env:APPROVED_ISOLATED_CONVEX_DEPLOYMENT",
      "$env:CONVEX_DEPLOYMENT = $ApprovedIsolatedDeployment",
      "bunx convex dev --once",
      "bunx convex run admin/migrations:seedGhanaJurisdiction",
      "bunx convex run admin/migrations:bootstrapSuperAdmins",
      "bun run test",
      "bun run build",
    ];

    let previousIndex = -1;
    for (const command of requiredSequence) {
      const commandIndex = bootstrap.indexOf(command, previousIndex + 1);
      expect(commandIndex, `missing command: ${command}`).toBeGreaterThan(
        previousIndex,
      );
      previousIndex = commandIndex;
    }
  });

  it("binds every Convex command to one confirmed isolated dev deployment", () => {
    expect(bootstrap).toContain(
      "$ApprovedIsolatedDeployment -notmatch '^dev:[a-z0-9-]+$'",
    );
    expect(bootstrap).toContain(
      "$ConfirmedIsolatedDeployment -cne $ApprovedIsolatedDeployment",
    );
    expect(bootstrap).toContain(
      "All three Convex commands read this same process-level `CONVEX_DEPLOYMENT` binding",
    );
    expect(bootstrap).toContain(
      "Abort before `bunx convex dev --once` if the value is missing, malformed, production, or differs from the pre-approved isolated target",
    );
  });
});
