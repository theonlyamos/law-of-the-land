import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  issueVerifiedPlaceClaim,
  verifyVerifiedPlaceClaim,
  type VerifiedPlace,
} from "./placeClaim";

const place: VerifiedPlace = {
  googlePlaceId: "ChIJdUyx15i3w0wR3kqRdl9Gq5A",
  name: "Accra",
  formattedAddress: "Accra, Ghana",
  latitude: 5.6037,
  longitude: -0.187,
  countryCode: "GH",
  aliases: ["Greater Accra", " Accra ", "greater accra"],
};

describe("verified place claims", () => {
  beforeEach(() => {
    process.env.PLACE_CLAIM_SECRET = "test-place-claim-secret-that-is-at-least-32-bytes";
  });

  afterEach(() => {
    delete process.env.PLACE_CLAIM_SECRET;
  });

  it("round trips a canonical actor-bound place for ten minutes", async () => {
    const issuedAt = 1_800_000_000_000;
    const claim = await issueVerifiedPlaceClaim("admin-1", place, issuedAt);

    await expect(
      verifyVerifiedPlaceClaim(claim, "admin-1", issuedAt + 599_999),
    ).resolves.toEqual({
      googlePlaceId: place.googlePlaceId,
      name: "Accra",
      formattedAddress: "Accra, Ghana",
      latitude: 5.6037,
      longitude: -0.187,
      countryCode: "GH",
      aliases: ["accra", "greater accra"],
    });
  });

  it("rejects a cross-actor, expired, or tampered claim with safe codes", async () => {
    const issuedAt = 1_800_000_000_000;
    const claim = await issueVerifiedPlaceClaim("admin-1", place, issuedAt);

    await expect(
      verifyVerifiedPlaceClaim(claim, "admin-2", issuedAt + 1),
    ).rejects.toThrow("PLACE_CLAIM_ACTOR_MISMATCH");
    await expect(
      verifyVerifiedPlaceClaim(claim, "admin-1", issuedAt + 600_001),
    ).rejects.toThrow("PLACE_CLAIM_EXPIRED");

    const tampered = `${claim.slice(0, -1)}${claim.endsWith("a") ? "b" : "a"}`;
    await expect(
      verifyVerifiedPlaceClaim(tampered, "admin-1", issuedAt + 1),
    ).rejects.toThrow("PLACE_CLAIM_INVALID");
  });

  it("expires exactly ten minutes after issuance", async () => {
    const issuedAt = 1_800_000_000_000;
    const claim = await issueVerifiedPlaceClaim("admin-1", place, issuedAt);

    await expect(
      verifyVerifiedPlaceClaim(claim, "admin-1", issuedAt + 600_000),
    ).rejects.toThrow("PLACE_CLAIM_EXPIRED");
  });

  it("rejects oversized decoded payloads before parsing", async () => {
    const oversized = `${"a".repeat(12_000)}.invalid`;
    await expect(
      verifyVerifiedPlaceClaim(oversized, "admin-1", Date.now()),
    ).rejects.toThrow("PLACE_CLAIM_INVALID");
  });
});
