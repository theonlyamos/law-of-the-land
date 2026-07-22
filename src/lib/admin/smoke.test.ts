import { describe, expect, it } from "vitest";
import { checkBudgets } from "../../../scripts/check-admin-budgets.mjs";

describe("admin performance budgets", () => {
  it("accepts the approved limits", () => {
    expect(checkBudgets({ lcp: 2400, inp: 180, cls: 0.05, routeJsGzip: 240_000, p95: 450 })).toEqual([]);
  });
});
