import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createPlacesProvider } from "./google-places-provider";

const SESSION_TOKEN = "de305d54-75b4-431b-adb2-eb6b9e546014";

function isolatedEnvironment(): Record<string, string | undefined> {
  const sha = "a".repeat(40);
  return {
    ADMIN_E2E_FIXTURE_MODE: "true",
    ADMIN_E2E_TARGET_ENV: "test",
    ADMIN_E2E_ISOLATED_TARGET_MARKER: "isolated-admin-e2e",
    ADMIN_E2E_PROVIDER_STUB_MODE: "true",
    ADMIN_E2E_CONVEX_URL: "http://127.0.0.1:3210",
    ADMIN_E2E_CONVEX_SITE_URL: "http://127.0.0.1:3211",
    ADMIN_E2E_APPROVED_COMMIT_SHA: sha,
    ADMIN_E2E_LOCAL_HEAD_SHA: sha,
  };
}

describe("Google Places provider seam", () => {
  it("uses injected production calls without changing their contract", async () => {
    const autocomplete = vi.fn().mockResolvedValue([]);
    const details = vi.fn().mockResolvedValue({ placeId: "normal-place" });
    const provider = createPlacesProvider({}, { autocomplete, details });

    await expect(provider.autocomplete("Acc", SESSION_TOKEN)).resolves.toEqual([]);
    await expect(provider.details("normal-place", SESSION_TOKEN))
      .resolves.toEqual({ placeId: "normal-place" });
    expect(autocomplete).toHaveBeenCalledWith("Acc", SESSION_TOKEN);
    expect(details).toHaveBeenCalledWith("normal-place", SESSION_TOKEN);
  });

  it("keeps the isolated Places stub bound to its exact session", async () => {
    const autocomplete = vi.fn();
    const details = vi.fn();
    const provider = createPlacesProvider(isolatedEnvironment(), { autocomplete, details });

    const suggestions = await provider.autocomplete("Acc", SESSION_TOKEN);
    expect(suggestions).toEqual([expect.objectContaining({
      primaryText: "Accra",
      secondaryText: "Ghana",
      types: ["locality", "political"],
    })]);
    await expect(provider.details(suggestions[0].placeId, SESSION_TOKEN)).resolves.toMatchObject({
      displayName: "Accra",
      formattedAddress: "Accra, Ghana",
      countryCode: "GH",
    });
    await expect(provider.details(suggestions[0].placeId, SESSION_TOKEN.toUpperCase()))
      .rejects.toThrow("GOOGLE_PLACES_INVALID_REQUEST");
    expect(autocomplete).not.toHaveBeenCalled();
    expect(details).not.toHaveBeenCalled();
  });

  it("fails closed for a partial isolation boundary", () => {
    expect(() => createPlacesProvider({ ADMIN_E2E_FIXTURE_MODE: "true" }))
      .toThrow("E2E_PROVIDER_ISOLATION_MISCONFIGURED");
  });

  it("rejects explicit default ports on remote isolated targets", () => {
    const environment = {
      ...isolatedEnvironment(),
      ADMIN_E2E_TARGET_ENV: "preview",
      ADMIN_E2E_CONVEX_URL:
        "https://adventurous-hummingbird-244.eu-west-1.convex.cloud:443",
      ADMIN_E2E_CONVEX_SITE_URL:
        "https://adventurous-hummingbird-244.eu-west-1.convex.site:443",
      CONVEX_DEPLOYMENT: "dev:adventurous-hummingbird-244",
    };

    expect(() => createPlacesProvider(environment))
      .toThrow("E2E_PROVIDER_ISOLATION_MISCONFIGURED");
  });
});
