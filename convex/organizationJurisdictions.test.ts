import { afterEach, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import {
  addOrganizationMember,
  createWidgetBackend,
  seedPublicWidget,
} from "./widgetTestHelpers.fixture";

afterEach(() => vi.unstubAllEnvs());
it("creates independent sibling libraries and retries without duplicate provider jobs", async () => {
  vi.stubEnv("ADMIN_ENVIRONMENT", "test");
  const t = createWidgetBackend(),
    f = await seedPublicWidget(t),
    manager = await addOrganizationMember(t, f.organizationId, "manager");
  const create = makeFunctionReference<"mutation">(
    "organizationJurisdictions:create",
  );
  const args = {
    organizationId: f.organizationId,
    name: "Employment policies",
    scopeMode: "global",
    geographicJurisdictionIds: [],
    idempotencyKey: "employment_create_01",
  };
  const id = await manager.client.mutation(create, args);
  expect(await manager.client.mutation(create, args)).toBe(id);
  expect(id).not.toBe(f.jurisdictionId);
  const rows = await t.run((ctx) => ctx.db.query("jurisdictions").collect());
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row._id === id)).toMatchObject({
    name: args.name,
    status: "draft",
    visibility: "members",
    organizationId: f.organizationId,
  });
  expect(
    await t.run((ctx) => ctx.db.query("integrationJobs").collect()),
  ).toHaveLength(1);
});
