const GOOGLE_PLACES_ORIGIN = "https://places.googleapis.com/v1";
const AUTOCOMPLETE_FIELD_MASK = "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types";
const DETAILS_FIELD_MASK = "id,displayName,formattedAddress,location,addressComponents,types";
const MAX_AUTOCOMPLETE_RESULTS = 5;
const MAX_TYPES = 20;
const MAX_ADDRESS_COMPONENTS = 32;
const MIN_API_KEY_LENGTH = 20;

export type PlaceSuggestion = {
  placeId: string;
  primaryText: string;
  secondaryText: string;
  types: string[];
};

export type VerifiedPlace = {
  placeId: string;
  displayName: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
  types: string[];
  countryCode?: string;
  addressComponents: Array<{
    longText: string;
    shortText: string;
    types: string[];
  }>;
};

function placesError(code: string): never {
  throw new Error(code);
}

function apiKey(): string {
  const value = process.env.PLACES_API_KEY?.trim();
  if (!value || value.length < MIN_API_KEY_LENGTH) {
    placesError("GOOGLE_PLACES_NOT_CONFIGURED");
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    placesError("GOOGLE_PLACES_INVALID_RESPONSE");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, maxLength: number): string {
  if (typeof value !== "string") placesError("GOOGLE_PLACES_INVALID_RESPONSE");
  const result = value.trim();
  if (!result || result.length > maxLength) {
    placesError("GOOGLE_PLACES_INVALID_RESPONSE");
  }
  return result;
}

function optionalText(value: unknown, maxLength: number): string {
  if (value === undefined) return "";
  return text(value, maxLength);
}

function stringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    placesError("GOOGLE_PLACES_INVALID_RESPONSE");
  }
  return value.map((item) => text(item, 100));
}

function validSessionToken(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validPlaceId(value: string): boolean {
  return value.length >= 1 && value.length <= 255 && value.trim() === value;
}

async function providerJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    placesError("GOOGLE_PLACES_UNAVAILABLE");
  }
  if (!response.ok) placesError("GOOGLE_PLACES_UNAVAILABLE");
  try {
    return await response.json();
  } catch {
    placesError("GOOGLE_PLACES_INVALID_RESPONSE");
  }
}

function projectSuggestion(value: unknown): PlaceSuggestion {
  const prediction = record(record(value).placePrediction);
  const structured = prediction.structuredFormat === undefined
    ? null
    : record(prediction.structuredFormat);
  const fullText = text(record(prediction.text).text, 500);
  const primaryText = structured?.mainText === undefined
    ? fullText
    : text(record(structured.mainText).text, 300);
  const secondaryText = structured?.secondaryText === undefined
    ? ""
    : optionalText(record(structured.secondaryText).text, 500);
  return {
    placeId: text(prediction.placeId, 255),
    primaryText,
    secondaryText,
    types: stringArray(prediction.types, MAX_TYPES),
  };
}

export async function autocompletePlaces(
  input: string,
  sessionToken: string,
): Promise<PlaceSuggestion[]> {
  const query = input.trim();
  if (query.length < 3 || query.length > 200 || !validSessionToken(sessionToken)) {
    placesError("GOOGLE_PLACES_INVALID_REQUEST");
  }
  const payload = record(await providerJson(`${GOOGLE_PLACES_ORIGIN}/places:autocomplete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": apiKey(),
      "X-Goog-FieldMask": AUTOCOMPLETE_FIELD_MASK,
    },
    body: JSON.stringify({
      input: query,
      sessionToken,
      includeQueryPredictions: false,
    }),
    cache: "no-store",
  }));
  if (payload.suggestions === undefined) return [];
  if (!Array.isArray(payload.suggestions)) {
    placesError("GOOGLE_PLACES_INVALID_RESPONSE");
  }
  return payload.suggestions
    .filter((suggestion) => {
      return Boolean(
        suggestion &&
        typeof suggestion === "object" &&
        !Array.isArray(suggestion) &&
        "placePrediction" in suggestion,
      );
    })
    .slice(0, MAX_AUTOCOMPLETE_RESULTS)
    .map(projectSuggestion);
}

export async function getVerifiedPlace(
  placeId: string,
  sessionToken: string,
): Promise<VerifiedPlace> {
  if (!validPlaceId(placeId) || !validSessionToken(sessionToken)) {
    placesError("GOOGLE_PLACES_INVALID_REQUEST");
  }
  const url = `${GOOGLE_PLACES_ORIGIN}/places/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(sessionToken)}`;
  const payload = record(await providerJson(url, {
    method: "GET",
    headers: {
      "X-Goog-Api-Key": apiKey(),
      "X-Goog-FieldMask": DETAILS_FIELD_MASK,
    },
    cache: "no-store",
  }));
  const responsePlaceId = text(payload.id, 255);
  if (responsePlaceId !== placeId) placesError("GOOGLE_PLACES_INVALID_RESPONSE");
  const location = record(payload.location);
  const latitude = location.latitude;
  const longitude = location.longitude;
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    placesError("GOOGLE_PLACES_INVALID_RESPONSE");
  }
  const rawComponents = payload.addressComponents ?? [];
  if (!Array.isArray(rawComponents) || rawComponents.length > MAX_ADDRESS_COMPONENTS) {
    placesError("GOOGLE_PLACES_INVALID_RESPONSE");
  }
  const addressComponents = rawComponents.map((component) => {
    const value = record(component);
    return {
      longText: text(value.longText, 300),
      shortText: text(value.shortText, 100),
      types: stringArray(value.types, MAX_TYPES),
    };
  });
  const country = addressComponents.find((component) => component.types.includes("country"));
  const countryCode = country && /^[A-Za-z]{2}$/.test(country.shortText)
    ? country.shortText.toUpperCase()
    : undefined;
  return {
    placeId: responsePlaceId,
    displayName: text(record(payload.displayName).text, 300),
    formattedAddress: text(payload.formattedAddress, 500),
    latitude,
    longitude,
    types: stringArray(payload.types, MAX_TYPES),
    ...(countryCode === undefined ? {} : { countryCode }),
    addressComponents,
  };
}
