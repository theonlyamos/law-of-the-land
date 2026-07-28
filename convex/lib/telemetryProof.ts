const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function encode(bytes: ArrayBuffer | Uint8Array): string {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function frame(parts: readonly (string | number)[]): string {
  return parts.map((part) => `${String(part).length}:${String(part)}`).join("|");
}

async function hmacKey(secret: string, usage: KeyUsage[]) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

function secret(): string {
  const value = process.env.TELEMETRY_INGEST_SECRET;
  if (!value || value.length < 32) {
    throw new Error("Telemetry ingestion is not configured");
  }
  return value;
}

export function createOpaqueTelemetryToken(): string {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

export function isOpaqueTelemetryToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export async function hashOpaqueTelemetryValue(value: string): Promise<string> {
  return encode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function createTelemetryServiceProof(
  parts: readonly (string | number)[],
): Promise<string> {
  return encode(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(secret(), ["sign"]),
      new TextEncoder().encode(frame(parts)),
    ),
  );
}

export async function createTelemetryPrincipalBinding(
  kind: "owner" | "session",
  value: string,
): Promise<string> {
  return createTelemetryServiceProof(["principal-binding-v1", kind, value]);
}

export async function verifyTelemetryServiceProof(
  proof: string,
  parts: readonly (string | number)[],
): Promise<boolean> {
  if (!PROOF_PATTERN.test(proof)) return false;
  const expected = await createTelemetryServiceProof(parts);
  const providedBytes = new TextEncoder().encode(proof);
  const expectedBytes = new TextEncoder().encode(expected);
  if (providedBytes.byteLength !== expectedBytes.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < providedBytes.byteLength; index += 1) {
    difference |= providedBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}
