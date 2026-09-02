export const RESEARCH_MANIFEST_PROOF_VERSION = "1";
export const RESEARCH_MANIFEST_REPLAY_WINDOW_MS = 30_000;
export const RESEARCH_MANIFEST_HEADERS = {
  version: "x-research-manifest-version",
  timestamp: "x-research-manifest-timestamp",
  nonce: "x-research-manifest-nonce",
  signature: "x-research-manifest-signature",
} as const;

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/u;
const TIMESTAMP = /^\d{13}$/u;

function encode(bytes: ArrayBuffer | Uint8Array): string {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decode32(value: string): Uint8Array | null {
  if (!BASE64URL_32_BYTES.test(value)) return null;
  let binary: string;
  try { binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "="); }
  catch { return null; }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.byteLength === 32 && encode(bytes) === value ? bytes : null;
}

function frame(parts: readonly string[]): Uint8Array {
  return new TextEncoder().encode(parts.map((part) => `${part.length}:${part}`).join("|"));
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function key(secret: string, usage: KeyUsage[]) {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 512 || secret !== secret.trim()) {
    throw new Error("Research manifest transport is not configured");
  }
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

async function bodyDigest(bodyBytes: Uint8Array): Promise<string> {
  return encode(await crypto.subtle.digest("SHA-256", exactArrayBuffer(bodyBytes)));
}

function proofFrame(input: {
  method: string;
  pathname: string;
  timestamp: string;
  nonce: string;
  bodyDigest: string;
}) {
  return frame([
    RESEARCH_MANIFEST_PROOF_VERSION,
    input.method,
    input.pathname,
    input.timestamp,
    input.nonce,
    input.bodyDigest,
  ]);
}

export function createResearchManifestNonce(): string {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createResearchManifestHeaders(input: {
  secret: string;
  method: string;
  pathname: string;
  timestamp: number;
  nonce: string;
  bodyBytes: Uint8Array;
}): Promise<Record<(typeof RESEARCH_MANIFEST_HEADERS)[keyof typeof RESEARCH_MANIFEST_HEADERS], string>> {
  const method = input.method.toUpperCase();
  const timestamp = String(input.timestamp);
  if (method !== input.method || method !== "POST" || !input.pathname.startsWith("/")
    || input.pathname.length > 128 || !TIMESTAMP.test(timestamp) || !decode32(input.nonce)
    || input.bodyBytes.byteLength > 1_024) {
    throw new Error("Research manifest request is invalid");
  }
  const digest = await bodyDigest(input.bodyBytes);
  const signature = encode(await crypto.subtle.sign(
    "HMAC",
    await key(input.secret, ["sign"]),
    exactArrayBuffer(proofFrame({ method, pathname: input.pathname, timestamp, nonce: input.nonce, bodyDigest: digest })),
  ));
  return {
    [RESEARCH_MANIFEST_HEADERS.version]: RESEARCH_MANIFEST_PROOF_VERSION,
    [RESEARCH_MANIFEST_HEADERS.timestamp]: timestamp,
    [RESEARCH_MANIFEST_HEADERS.nonce]: input.nonce,
    [RESEARCH_MANIFEST_HEADERS.signature]: signature,
  };
}

export async function verifyResearchManifestProof(input: {
  secret: string;
  method: string;
  pathname: string;
  version: string;
  timestamp: string;
  nonce: string;
  signature: string;
  bodyBytes: Uint8Array;
  now: number;
}): Promise<{ nonceHash: string; expiresAt: number } | null> {
  if (input.version !== RESEARCH_MANIFEST_PROOF_VERSION || input.method !== "POST"
    || !input.pathname.startsWith("/") || input.pathname.length > 128
    || !TIMESTAMP.test(input.timestamp) || !decode32(input.nonce) || !decode32(input.signature)
    || input.bodyBytes.byteLength > 1_024
    || !Number.isSafeInteger(input.now)) return null;
  const timestamp = Number(input.timestamp);
  if (!Number.isSafeInteger(timestamp)
    || timestamp < input.now - RESEARCH_MANIFEST_REPLAY_WINDOW_MS
    || timestamp > input.now + RESEARCH_MANIFEST_REPLAY_WINDOW_MS) return null;
  let verified = false;
  try {
    verified = await crypto.subtle.verify(
      "HMAC",
      await key(input.secret, ["verify"]),
      exactArrayBuffer(decode32(input.signature)!),
      exactArrayBuffer(proofFrame({ method: input.method, pathname: input.pathname, timestamp: input.timestamp, nonce: input.nonce, bodyDigest: await bodyDigest(input.bodyBytes) })),
    );
  } catch { return null; }
  if (!verified) return null;
  return {
    nonceHash: encode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.nonce))),
    expiresAt: timestamp + RESEARCH_MANIFEST_REPLAY_WINDOW_MS,
  };
}
