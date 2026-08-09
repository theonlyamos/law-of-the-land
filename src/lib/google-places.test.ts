import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autocompletePlaces, getVerifiedPlace } from "./google-places";

const sessionToken = "de305d54-75b4-431b-adb2-eb6b9e546014";
const apiKey = "test-google-places-api-key-with-safe-length";

function prediction(index: number) {
  return {
    placePrediction: {
      placeId: `place-${index}`,
      text: { text: `Accra result ${index}` },
      structuredFormat: {
        mainText: { text: `Accra ${index}` },
        secondaryText: { text: "Ghana" },
      },
      types: ["locality", "political"],
    },
  };
}

describe("Google Places server adapter", () => {
  beforeEach(() => {
    process.env.PLACES_API_KEY = apiKey;
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    delete process.env.PLACES_API_KEY;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("forwards only the autocomplete field mask and returns five place predictions", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      suggestions: Array.from({ length: 7 }, (_, index) => prediction(index + 1)),
    }));

    const suggestions = await autocompletePlaces("Acc", sessionToken);

    expect(suggestions).toEqual(Array.from({ length: 5 }, (_, index) => ({
      placeId: `place-${index + 1}`,
      primaryText: `Accra ${index + 1}`,
      secondaryText: "Ghana",
      types: ["locality", "political"],
    })));
    expect(fetch).toHaveBeenCalledWith(
      "https://places.googleapis.com/v1/places:autocomplete",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types",
        },
        body: JSON.stringify({
          input: "Acc",
          sessionToken,
          includeQueryPredictions: false,
        }),
        cache: "no-store",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("requests only verified details and safely projects the provider response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      id: "ChIJ/a?b",
      displayName: { text: "Accra" },
      formattedAddress: "Accra, Ghana",
      location: { latitude: 5.6037, longitude: -0.187 },
      types: ["locality", "political"],
      addressComponents: [
        { longText: "Ghana", shortText: "GH", types: ["country", "political"] },
        { longText: "Greater Accra Region", shortText: "Greater Accra", types: ["administrative_area_level_1", "political"] },
      ],
      unexpectedCanonicalField: "must not escape",
    }));

    await expect(getVerifiedPlace("ChIJ/a?b", sessionToken)).resolves.toEqual({
      placeId: "ChIJ/a?b",
      displayName: "Accra",
      formattedAddress: "Accra, Ghana",
      latitude: 5.6037,
      longitude: -0.187,
      types: ["locality", "political"],
      countryCode: "GH",
      addressComponents: [
        { longText: "Ghana", shortText: "GH", types: ["country", "political"] },
        { longText: "Greater Accra Region", shortText: "Greater Accra", types: ["administrative_area_level_1", "political"] },
      ],
    });
    expect(fetch).toHaveBeenCalledWith(
      `https://places.googleapis.com/v1/places/ChIJ%2Fa%3Fb?sessionToken=${sessionToken}`,
      {
        method: "GET",
        headers: {
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "id,displayName,formattedAddress,location,addressComponents,types",
        },
        cache: "no-store",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("rejects missing configuration, provider failures, and malformed provider data without leaking details", async () => {
    delete process.env.PLACES_API_KEY;
    await expect(autocompletePlaces("Acc", sessionToken)).rejects.toThrow("GOOGLE_PLACES_NOT_CONFIGURED");
    expect(fetch).not.toHaveBeenCalled();

    process.env.PLACES_API_KEY = apiKey;
    vi.mocked(fetch).mockResolvedValueOnce(new Response("secret upstream body", { status: 403 }));
    await expect(autocompletePlaces("Acc", sessionToken)).rejects.toThrow("GOOGLE_PLACES_UNAVAILABLE");

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ id: "place-without-required-fields" }));
    await expect(getVerifiedPlace("place-without-required-fields", sessionToken)).rejects.toThrow("GOOGLE_PLACES_INVALID_RESPONSE");
  });

  it("rejects a declared oversized provider response before parsing it", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("not-json"));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(stream, {
      headers: { "content-length": "65537" },
    }));

    await expect(autocompletePlaces("Acc", sessionToken)).rejects.toThrow(
      "GOOGLE_PLACES_UNAVAILABLE",
    );
    expect(cancelled).toBe(true);
  });

  it("cancels a non-OK provider body and maps it without exposing the body", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("secret provider error body"));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(stream, { status: 503 }));

    const result = await autocompletePlaces("Acc", sessionToken).catch(
      (error: unknown) => error,
    );

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("GOOGLE_PLACES_UNAVAILABLE");
    expect(cancelled).toBe(true);
  });

  it.each([
    ["absent", undefined],
    ["falsely small", "1"],
  ])("stream-bounds and cancels a provider response when Content-Length is %s", async (_name, contentLength) => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `${JSON.stringify({ suggestions: [] })}${" ".repeat(65_537)}`,
        ));
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers = contentLength === undefined ? undefined : { "content-length": contentLength };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(stream, { headers }));

    await expect(autocompletePlaces("Acc", sessionToken)).rejects.toThrow(
      "GOOGLE_PLACES_UNAVAILABLE",
    );
    expect(cancelled).toBe(true);
  });

  it("aborts a provider request within ten seconds and maps it safely", async () => {
    vi.useFakeTimers();
    let aborted = false;
    vi.mocked(fetch).mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("provider timeout detail", "AbortError"));
      }, { once: true });
    }));
    const outcome = autocompletePlaces("Acc", sessionToken).then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.message : "unknown",
    );

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(Promise.race([outcome, Promise.resolve("pending")])).resolves.toBe(
      "GOOGLE_PLACES_UNAVAILABLE",
    );
    expect(aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the provider deadline after an early response", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ suggestions: [] }));

    await expect(autocompletePlaces("Acc", sessionToken)).resolves.toEqual([]);

    expect(vi.getTimerCount()).toBe(0);
  });
});
