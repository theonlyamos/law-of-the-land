import { describe, expect, it } from "vitest";
import { ADMIN_ROLES, hasRolePermission } from "../lib/adminPermissions";
import { E2E_PRIVILEGED_FUNCTIONS, E2E_PROTECTED_ROUTES } from "./e2eAccessMatrix";

describe("admin E2E authorization matrix", () => {
  it("covers every fixed role against every protected route and privileged function", () => {
    const entries = [...E2E_PROTECTED_ROUTES, ...E2E_PRIVILEGED_FUNCTIONS];
    expect(entries.length).toBeGreaterThanOrEqual(24);
    for (const entry of entries) {
      for (const role of ADMIN_ROLES) {
        const granted = "permissions" in entry
          ? entry.permissions.some(([resource, action]) => hasRolePermission([role], resource, action))
          : hasRolePermission([role], entry.resource, entry.action);
        expect(
          granted,
          `${role} -> ${"path" in entry ? entry.path : "unknown"}`,
        ).toBe(entry.allowed.includes(role as never));
      }
      const normalGranted = "permissions" in entry
        ? entry.permissions.some(([resource, action]) => hasRolePermission(["user"], resource, action))
        : hasRolePermission(["user"], entry.resource, entry.action);
      expect(normalGranted).toBe(false);
    }
  });

  it("contains no duplicate route or function entries and includes every required domain", () => {
    expect(new Set(E2E_PROTECTED_ROUTES.map((entry) => entry.path)).size).toBe(E2E_PROTECTED_ROUTES.length);
    expect(new Set(E2E_PRIVILEGED_FUNCTIONS.map((entry) => entry.path)).size).toBe(E2E_PRIVILEGED_FUNCTIONS.length);
    expect(new Set(E2E_PRIVILEGED_FUNCTIONS.map((entry) => entry.path.split("/")[1].split(":")[0]))).toEqual(
      new Set(["users", "conversations", "exports", "resources", "reviews", "publication", "billing", "jobs", "operations"]),
    );
  });
});
