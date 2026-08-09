const CLAIM_VERSION = 1;
const CLAIM_TTL_MS = 10 * 60 * 1_000;
const MAX_PAYLOAD_BYTES = 8_192;
const MAX_TOKEN_LENGTH = 12_000;
const MAX_ACTOR_ID_LENGTH = 500;
const MAX_PLACE_NAME_LENGTH = 300;
const MAX_FORMATTED_ADDRESS_LENGTH = 500;
const MAX_ALIASES = 20;
const MAX_ALIAS_LENGTH = 200;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type VerifiedPlace = {
  googlePlaceId: string;
  name: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
  countryCode?: string;
  aliases: string[];
};

type PlaceClaimPayload = {
  version: 1;
  actorId: string;
  issuedAt: number;
  expiresAt: number;
  place: VerifiedPlace;
};

function invalid(code = "PLACE_CLAIM_INVALID"): never {
  throw new Error(code);
}

function claimSecret(): string {
  const value = process.env.PLACE_CLAIM_SECRET;
  if (!value || value.length < 32) invalid("PLACE_CLAIM_NOT_CONFIGURED");
  return value;
}

function encode(bytes: ArrayBuffer | Uint8Array): string {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!value || !BASE64URL_PATTERN.test(value)) invalid();
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    if (encode(bytes) !== value) invalid();
    return bytes;
  } catch {
    invalid();
  }
}

async function hmacKey(usage: KeyUsage[]): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(claimSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") invalid();
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maxLength) invalid();
  return normalized;
}

function opaqueActorId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_ACTOR_ID_LENGTH) invalid();
  return value;
}

function canonicalAlias(value: unknown): string {
  return boundedText(value, MAX_ALIAS_LENGTH).toLocaleLowerCase("en");
}

function canonicalPlace(value: unknown): VerifiedPlace {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  const googlePlaceId = boundedText(input.googlePlaceId, 255);
  const name = boundedText(input.name, MAX_PLACE_NAME_LENGTH);
  const formattedAddress = boundedText(
    input.formattedAddress,
    MAX_FORMATTED_ADDRESS_LENGTH,
  );
  if (
    typeof input.latitude !== "number" ||
    !Number.isFinite(input.latitude) ||
    input.latitude < -90 ||
    input.latitude > 90 ||
    typeof input.longitude !== "number" ||
    !Number.isFinite(input.longitude) ||
    input.longitude < -180 ||
    input.longitude > 180
  ) {
    invalid();
  }
  if (!Array.isArray(input.aliases) || input.aliases.length > MAX_ALIASES) invalid();
  const aliases = [...new Set([
    canonicalAlias(name),
    ...input.aliases.map(canonicalAlias),
  ])].sort();
  if (aliases.length > MAX_ALIASES) invalid();
  let countryCode: string | undefined;
  if (input.countryCode !== undefined) {
    if (typeof input.countryCode !== "string") invalid();
    countryCode = input.countryCode.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) invalid();
  }
  return {
    googlePlaceId,
    name,
    formattedAddress,
    latitude: input.latitude,
    longitude: input.longitude,
    ...(countryCode === undefined ? {} : { countryCode }),
    aliases,
  };
}

function canonicalPayload(payload: PlaceClaimPayload): string {
  const place = payload.place;
  return JSON.stringify({
    version: CLAIM_VERSION,
    actorId: payload.actorId,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    place: {
      googlePlaceId: place.googlePlaceId,
      name: place.name,
      formattedAddress: place.formattedAddress,
      latitude: place.latitude,
      longitude: place.longitude,
      ...(place.countryCode === undefined ? {} : { countryCode: place.countryCode }),
      aliases: place.aliases,
    },
  });
}

function parsedPayload(value: string): PlaceClaimPayload {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    invalid();
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) invalid();
  const input = decoded as Record<string, unknown>;
  if (
    input.version !== CLAIM_VERSION ||
    typeof input.issuedAt !== "number" ||
    !Number.isSafeInteger(input.issuedAt) ||
    typeof input.expiresAt !== "number" ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt - input.issuedAt !== CLAIM_TTL_MS
  ) {
    invalid();
  }
  const payload: PlaceClaimPayload = {
    version: CLAIM_VERSION,
    actorId: opaqueActorId(input.actorId),
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    place: canonicalPlace(input.place),
  };
  if (!Number.isSafeInteger(payload.expiresAt)) invalid();
  if (canonicalPayload(payload) !== value) invalid();
  return payload;
}

export async function issueVerifiedPlaceClaim(
  actorId: string,
  place: VerifiedPlace,
  issuedAt = Date.now(),
): Promise<string> {
  const normalizedActorId = opaqueActorId(actorId);
  if (!Number.isSafeInteger(issuedAt)) invalid();
  const payload: PlaceClaimPayload = {
    version: CLAIM_VERSION,
    actorId: normalizedActorId,
    issuedAt,
    expiresAt: issuedAt + CLAIM_TTL_MS,
    place: canonicalPlace(place),
  };
  if (!Number.isSafeInteger(payload.expiresAt)) invalid();
  const payloadBytes = new TextEncoder().encode(canonicalPayload(payload));
  if (payloadBytes.byteLength > MAX_PAYLOAD_BYTES) invalid();
  const encodedPayload = encode(payloadBytes);
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(["sign"]),
    new TextEncoder().encode(encodedPayload),
  );
  return `${encodedPayload}.${encode(signature)}`;
}

export async function verifyVerifiedPlaceClaim(
  claim: string,
  actorId: string,
  now = Date.now(),
): Promise<VerifiedPlace> {
  if (claim.length > MAX_TOKEN_LENGTH) invalid();
  const parts = claim.split(".");
  if (parts.length !== 2) invalid();
  const [encodedPayload, encodedSignature] = parts;
  const payloadBytes = decode(encodedPayload);
  if (payloadBytes.byteLength > MAX_PAYLOAD_BYTES) invalid();
  const signature = decode(encodedSignature);
  if (signature.byteLength !== 32) invalid();
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(["verify"]),
    signature,
    new TextEncoder().encode(encodedPayload),
  );
  if (!valid) invalid();
  let decodedPayload: string;
  try {
    decodedPayload = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
  } catch {
    invalid();
  }
  const payload = parsedPayload(decodedPayload);
  if (payload.actorId !== opaqueActorId(actorId)) invalid("PLACE_CLAIM_ACTOR_MISMATCH");
  if (!Number.isSafeInteger(now) || now < payload.issuedAt - 60_000) invalid();
  if (now >= payload.expiresAt) invalid("PLACE_CLAIM_EXPIRED");
  return payload.place;
}
