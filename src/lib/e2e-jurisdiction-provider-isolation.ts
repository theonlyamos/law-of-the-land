import "server-only";

import { timingSafeEqual } from "node:crypto";
import {
  E2E_JURISDICTION_QUESTIONS,
  encodeRetrievalObservationV1Value,
  type E2EProviderScenario,
  type RetrievalObservationV1,
} from "../../shared/e2e-jurisdiction-provider-contract";

type Environment = Record<string, string | undefined>;
type StubMode = {
  mode: "stub";
  scenarioForQuestion(question: string): E2EProviderScenario;
  observationSecret: string;
};
export type JurisdictionProviderMode = { mode: "normal" } | StubMode;

const BOUNDARY_KEYS = [
  "ADMIN_E2E_FIXTURE_MODE",
  "ADMIN_E2E_TARGET_ENV",
  "ADMIN_E2E_ISOLATED_TARGET_MARKER",
  "ADMIN_E2E_PROVIDER_STUB_MODE",
  "ADMIN_E2E_CONVEX_URL",
  "ADMIN_E2E_CONVEX_SITE_URL",
  "ADMIN_E2E_APPROVED_COMMIT_SHA",
  "ADMIN_E2E_LOCAL_HEAD_SHA",
  "ADMIN_E2E_PROVIDER_OBSERVATION_SECRET",
] as const;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const OBSERVATION_HEADER = "x-admin-e2e-provider-observation";

function invalidBoundary(): never {
  throw new Error("E2E_JURISDICTION_PROVIDER_BOUNDARY_INVALID");
}

function exact(environment: Environment, key: string): string {
  const value = environment[key];
  if (typeof value !== "string" || !value || value !== value.trim()) invalidBoundary();
  return value;
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function isProductionLooking(value: string): boolean {
  return /(?:^|[.:-])(?:prod|production|live)(?:[.:-]|$)/i.test(value);
}

function parseEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidBoundary();
  }
  if (!/^https?:$/.test(url.protocol)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || isProductionLooking(url.hostname)) {
    invalidBoundary();
  }
  return url;
}

function remoteDeploymentName(url: URL, suffix: string): string | null {
  if (!url.hostname.endsWith(suffix)) return null;
  const name = url.hostname.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) ? name : null;
}

function validatePairedEndpoints(environment: Environment): void {
  const convexUrl = parseEndpoint(exact(environment, "ADMIN_E2E_CONVEX_URL"));
  const siteUrl = parseEndpoint(exact(environment, "ADMIN_E2E_CONVEX_SITE_URL"));
  const localBackend = isLocalhost(convexUrl.hostname);
  const localSite = isLocalhost(siteUrl.hostname);
  if (localBackend !== localSite) invalidBoundary();
  if (localBackend) {
    if (convexUrl.hostname !== siteUrl.hostname) invalidBoundary();
    return;
  }
  if (convexUrl.protocol !== "https:" || siteUrl.protocol !== "https:") invalidBoundary();
  if (convexUrl.port || siteUrl.port) invalidBoundary();
  const backendName = remoteDeploymentName(convexUrl, ".convex.cloud");
  const siteName = remoteDeploymentName(siteUrl, ".convex.site");
  if (!backendName || backendName !== siteName) invalidBoundary();
}

function validateObservationSecret(value: string): void {
  if (!BASE64URL_PATTERN.test(value) || value.length > 172 || value.length % 4 === 1) invalidBoundary();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength < 32 || bytes.byteLength > 128 || bytes.toString("base64url") !== value) invalidBoundary();
}

export function resolveJurisdictionProviderMode(
  environment: Environment,
): JurisdictionProviderMode {
  if (BOUNDARY_KEYS.every((key) => environment[key] === undefined)) return { mode: "normal" };
  if (exact(environment, "ADMIN_E2E_FIXTURE_MODE") !== "true"
    || !["test", "preview"].includes(exact(environment, "ADMIN_E2E_TARGET_ENV"))
    || exact(environment, "ADMIN_E2E_ISOLATED_TARGET_MARKER") !== "isolated-admin-e2e"
    || exact(environment, "ADMIN_E2E_PROVIDER_STUB_MODE") !== "true"
    || isProductionLooking(environment.CONVEX_DEPLOYMENT ?? "")) {
    invalidBoundary();
  }
  validatePairedEndpoints(environment);
  const approvedCommitSha = exact(environment, "ADMIN_E2E_APPROVED_COMMIT_SHA");
  const localHeadSha = exact(environment, "ADMIN_E2E_LOCAL_HEAD_SHA");
  if (!SHA_PATTERN.test(approvedCommitSha)
    || !SHA_PATTERN.test(localHeadSha)
    || approvedCommitSha !== localHeadSha) {
    invalidBoundary();
  }
  const observationSecret = exact(environment, "ADMIN_E2E_PROVIDER_OBSERVATION_SECRET");
  validateObservationSecret(observationSecret);

  return {
    mode: "stub",
    observationSecret,
    scenarioForQuestion(question) {
      for (const [scenario, exactQuestion] of Object.entries(E2E_JURISDICTION_QUESTIONS)) {
        if (question === exactQuestion) return scenario as E2EProviderScenario;
      }
      throw new Error("E2E_JURISDICTION_PROVIDER_SCENARIO_INVALID");
    },
  };
}

function isResolvedProviderMode(
  value: Environment | JurisdictionProviderMode,
): value is JurisdictionProviderMode {
  const keys = Object.keys(value).sort();
  if (value.mode === "normal") {
    return keys.length === 1 && keys[0] === "mode";
  }
  if (value.mode !== "stub") return false;
  const stub = value as Partial<StubMode>;
  return keys.length === 3
    && keys[0] === "mode"
    && keys[1] === "observationSecret"
    && keys[2] === "scenarioForQuestion"
    && typeof stub.scenarioForQuestion === "function"
    && typeof stub.observationSecret === "string";
}

export function authorizedObservationSecret(
  request: Request,
  environmentOrMode: Environment | JurisdictionProviderMode,
): boolean {
  const mode = isResolvedProviderMode(environmentOrMode)
    ? environmentOrMode
    : resolveJurisdictionProviderMode(environmentOrMode);
  if (mode.mode !== "stub") return false;
  const candidate = request.headers.get(OBSERVATION_HEADER);
  if (candidate === null) return false;
  const expectedBytes = Buffer.from(mode.observationSecret, "utf8");
  const candidateBytes = Buffer.from(candidate, "utf8");
  return expectedBytes.byteLength === candidateBytes.byteLength
    && timingSafeEqual(expectedBytes, candidateBytes);
}

export function encodeRetrievalObservationV1(value: RetrievalObservationV1): string {
  return encodeRetrievalObservationV1Value(value);
}
