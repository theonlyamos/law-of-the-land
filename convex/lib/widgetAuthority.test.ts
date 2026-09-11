import { expect, it } from "vitest";
import { createWidgetBackend, seedPublicWidget } from "../widgetTestHelpers.fixture";
import { resolveWidgetAuthority } from "./widgetAuthority";

it("resolves only the selected public organization and denies private or foreign frames", async () => {
  const t = createWidgetBackend();
  const f = await seedPublicWidget(t);
  expect((await t.run(ctx => resolveWidgetAuthority(ctx, f.publicId, "https://greenfield.example"))).store.relation).toBe("selected");
  await expect(t.run(ctx => resolveWidgetAuthority(ctx, f.publicId, "https://attacker.example"))).rejects.toThrow("WIDGET_UNAVAILABLE");
  await t.run(ctx => ctx.db.patch(f.jurisdictionId, { visibility: "members" }));
  await expect(t.run(ctx => resolveWidgetAuthority(ctx, f.publicId, "https://greenfield.example"))).rejects.toThrow("WIDGET_UNAVAILABLE");
});
