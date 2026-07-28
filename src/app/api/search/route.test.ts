import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

const authMocks = vi.hoisted(() => ({
  fetchAuthMutation: vi.fn(),
  fetchAuthQuery: vi.fn(),
  isAuthenticated: vi.fn(),
}));

const groundxMocks = vi.hoisted(() => ({
  searchContent: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => authMocks);
vi.mock("groundx-typescript-sdk", () => ({
  Groundx: class {
    search = { content: groundxMocks.searchContent };
  },
}));

import { POST } from "./route";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
}

const gh = {
  code: "GH",
  name: "Ghana",
  slug: "ghana",
  enabled: true as const,
  isDefault: true,
  productionBucketId: "11833",
};

describe("POST /api/search governed jurisdiction lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.isAuthenticated.mockResolvedValue(true);
    authMocks.fetchAuthMutation.mockResolvedValue(undefined);
    authMocks.fetchAuthQuery.mockResolvedValue(gh);
    groundxMocks.searchContent.mockResolvedValue({
      data: { search: { text: "governed answer" } },
    });
  });

  it("uses the governed production bucket returned by Convex", async () => {
    const response = await POST(request({ query: "What is the law?", country: "gh" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "governed answer" });
    expect(authMocks.fetchAuthQuery).toHaveBeenCalledWith(
      expect.anything(),
      { code: "GH" },
    );
    expect(getFunctionName(authMocks.fetchAuthQuery.mock.calls[0][0])).toBe(
      "jurisdictions:getPublicByCode",
    );
    expect(groundxMocks.searchContent).toHaveBeenCalledWith({
      id: 11833,
      query: "What is the law?",
    });
  });

  it("rejects an unknown jurisdiction before quota or GroundX calls", async () => {
    authMocks.fetchAuthQuery.mockResolvedValue(null);

    const response = await POST(request({ query: "Question", country: "ZZ" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That country is not supported yet." });
    expect(authMocks.fetchAuthQuery).toHaveBeenCalledWith(
      expect.anything(),
      { code: "ZZ" },
    );
    expect(getFunctionName(authMocks.fetchAuthQuery.mock.calls[0][0])).toBe(
      "jurisdictions:getPublicByCode",
    );
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(groundxMocks.searchContent).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled", { ...gh, enabled: false }],
    ["missing production bucket", { ...gh, productionBucketId: "" }],
  ])("rejects a %s jurisdiction before GroundX", async (_case, jurisdiction) => {
    authMocks.fetchAuthQuery.mockResolvedValue(jurisdiction);

    const response = await POST(request({ query: "Question", country: "GH" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That country is not supported yet." });
    expect(authMocks.fetchAuthMutation).not.toHaveBeenCalled();
    expect(groundxMocks.searchContent).not.toHaveBeenCalled();
  });
});
