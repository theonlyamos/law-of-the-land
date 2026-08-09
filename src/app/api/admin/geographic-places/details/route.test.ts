import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  isAuthenticated: vi.fn(),
  fetchAuthQuery: vi.fn(),
}));
const placesMocks = vi.hoisted(() => ({ getVerifiedPlace: vi.fn() }));
const claimMocks = vi.hoisted(() => ({
  issueVerifiedPlaceClaim: vi.fn(),
  VERIFIED_PLACE_CLAIM_TTL_MS: 600_000,
}));
const rateLimitMocks = vi.hoisted(() => ({ rateLimit: vi.fn() }));

vi.mock("@/lib/auth-server", () => authMocks);
vi.mock("@/lib/google-places", () => placesMocks);
vi.mock("@/lib/rate-limit", () => rateLimitMocks);
vi.mock("../../../../../../convex/lib/placeClaim", () => claimMocks);

import { POST } from "./route";

const sessionToken = "de305d54-75b4-431b-adb2-eb6b9e546014";
const place = {
  placeId: "place-1",
  displayName: "Accra",
  formattedAddress: "Accra, Ghana",
  latitude: 5.6037,
  longitude: -0.187,
  types: ["locality", "political"],
  countryCode: "GH",
  addressComponents: [
    { longText: "Ghana", shortText: "GH", types: ["country", "political"] },
  ],
};

function request(body: string | Record<string, unknown>, contentLength?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return new Request("http://localhost/api/admin/geographic-places/details", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/admin/geographic-places/details", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.isAuthenticated.mockResolvedValue(true);
    authMocks.fetchAuthQuery.mockResolvedValue("admin-actor-1");
    rateLimitMocks.rateLimit.mockReturnValue({ ok: true, retryAfterSeconds: 0 });
    placesMocks.getVerifiedPlace.mockResolvedValue(place);
    claimMocks.issueVerifiedPlaceClaim.mockResolvedValue("signed-verified-place");
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects invalid place IDs, invalid sessions, and oversized bodies before authorization or Google", async () => {
    expect((await POST(request({ placeId: "", sessionToken }))).status).toBe(400);
    expect((await POST(request({ placeId: "place-1", sessionToken: "not-a-v4-uuid" }))).status).toBe(400);
    const valid = JSON.stringify({ placeId: "place-1", sessionToken });
    const oversized = `${valid}${" ".repeat(1_025 - valid.length)}`;
    expect((await POST(request(oversized, "1"))).status).toBe(400);
    expect(authMocks.isAuthenticated).not.toHaveBeenCalled();
    expect(authMocks.fetchAuthQuery).not.toHaveBeenCalled();
    expect(placesMocks.getVerifiedPlace).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated or unauthorized requests before Google", async () => {
    authMocks.isAuthenticated.mockResolvedValueOnce(false);
    expect((await POST(request({ placeId: "place-1", sessionToken }))).status).toBe(401);
    expect(authMocks.fetchAuthQuery).not.toHaveBeenCalled();
    expect(placesMocks.getVerifiedPlace).not.toHaveBeenCalled();

    authMocks.fetchAuthQuery.mockRejectedValueOnce({ data: { code: "ADMIN_DISABLED" } });
    expect((await POST(request({ placeId: "place-1", sessionToken }))).status).toBe(403);
    expect(placesMocks.getVerifiedPlace).not.toHaveBeenCalled();
  });

  it("returns only the verified place, actor-bound claim, and expiry", async () => {
    const response = await POST(request({
      placeId: "place-1",
      sessionToken,
      displayName: "Forged name",
      latitude: 0,
      longitude: 0,
      countryCode: "US",
      addressComponents: [],
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      place,
      verifiedPlaceClaim: "signed-verified-place",
      expiresAt: 1_800_000_600_000,
    });
    expect(getFunctionName(authMocks.fetchAuthQuery.mock.calls[0][0])).toBe(
      "admin/jurisdictions:assertCanManageJurisdictions",
    );
    expect(rateLimitMocks.rateLimit).toHaveBeenCalledWith("places:admin-actor-1", expect.any(Number));
    expect(placesMocks.getVerifiedPlace).toHaveBeenCalledWith("place-1", sessionToken);
    expect(claimMocks.issueVerifiedPlaceClaim).toHaveBeenCalledWith(
      "admin-actor-1",
      {
        googlePlaceId: "place-1",
        name: "Accra",
        formattedAddress: "Accra, Ghana",
        latitude: 5.6037,
        longitude: -0.187,
        countryCode: "GH",
        aliases: ["Ghana", "GH"],
      },
      1_800_000_000_000,
    );
    expect(claimMocks.issueVerifiedPlaceClaim.mock.invocationCallOrder[0]).toBeGreaterThan(
      placesMocks.getVerifiedPlace.mock.invocationCallOrder[0],
    );
  });

  it("returns a safe retryable error without signing when Google fails", async () => {
    placesMocks.getVerifiedPlace.mockRejectedValueOnce(new Error("provider body with secret"));

    const response = await POST(request({ placeId: "place-1", sessionToken }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(JSON.stringify(body)).not.toContain("provider body with secret");
    expect(claimMocks.issueVerifiedPlaceClaim).not.toHaveBeenCalled();
  });
});
