import { makeSignature } from "better-auth/crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const FIXED_ROLES = [
  "super_admin",
  "content_manager",
  "content_reviewer",
  "support_agent",
  "billing_manager",
  "auditor",
] as const;

type FixedRole = (typeof FIXED_ROLES)[number];
type Environment = Record<string, string | undefined>;
type RequestFunction = (url: string, init: RequestInit) => Promise<Response>;

export type AdminE2ETarget = {
  environment: "test" | "preview";
  convexUrl: string;
  convexSiteUrl: string;
  fixtureSecret: string;
  betterAuthSecret: string;
  accountPassword: string;
  approvedCommitSha: string;
};

type FixtureRecoveryManifest = {
  version: 2;
  state: "provisional" | "ready";
  tag: string;
  targetClass: "test" | "preview";
  approvedCommitSha: string;
  convexUrl: string;
  convexSiteUrl: string;
  cleanupEndpoint: "/admin/e2e-fixtures/cleanup";
};

type FixtureRecords = {
  chatId: string;
  resourceId: string;
  publishedVersionId: string;
  reviewVersionId: string;
  separationVersionId: string;
  conversationGrantId: string;
  jurisdictionId: string;
  userId: string;
  stagingBucketId: string;
  productionBucketId: string;
  callbackToken: string;
  callbackJobId: string;
  usageUserId: string;
  jurisdictionCountryId: string;
  jurisdictionTownId: string;
  publicOrganizationJurisdictionId: string;
  jurisdictionMemberOnlyId: string;
  jurisdictionMemberId: string;
  jurisdictionFormerMemberId: string;
};

export type FixtureManifest = FixtureRecoveryManifest & {
  state: "ready";
  sessions: Partial<Record<FixedRole, string>>;
  variants: {
    normal: { userId: string; cookie: string };
    noTwoFactor: { userId: string; cookie: string };
    unassured: { userId: string; cookie: string };
  };
  jurisdictionUsers: Record<"member" | "formerMember", { userId: string; cookie: string }>;
  records: FixtureRecords;
};

type BootstrapResponse = {
  tag: string;
  providerTransport: "stub";
  deployedCommitSha: string;
  billingDisabled: true;
  sessions: Record<FixedRole, { userId: string; sessionToken: string }>;
  variants: Record<"normal" | "noTwoFactor" | "unassured", { userId: string; sessionToken: string }>;
  jurisdictionUsers: Record<"member" | "formerMember", { userId: string; sessionToken: string }>;
  records: FixtureRecords;
};

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const FIXTURE_TAG_PATTERN = /^e2e_[a-z0-9]{12,48}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function required(environment: Environment, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`${key} is required for admin E2E fixtures.`);
  return value;
}

function parsedEndpoint(value: string, key: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute HTTP(S) URL.`);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${key} must be a credential-free HTTP(S) origin.`);
  }
  return url;
}

function requiredCanonicalSecret(environment: Environment, key: string): string {
  const value = environment[key];
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`${key} must be an exact canonical 32-byte base64url value.`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1 || bytes.byteLength !== 32 || bytes.toString("base64url") !== value) {
    throw new Error(`${key} must be an exact canonical 32-byte base64url value.`);
  }
  return value;
}

function hasExplicitPort(value: string): boolean {
  const authority = value.slice(value.indexOf("://") + 3).split(/[/?#]/, 1)[0];
  return /:\d+$/.test(authority);
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function productionLooking(url: URL): boolean {
  return /(?:^|[.-])(?:prod|production|live)(?:[.-]|$)/i.test(url.hostname);
}

function remoteDeployment(url: URL, suffix: string): { name: string; region: string } | null {
  if (!url.hostname.endsWith(suffix)) return null;
  const labels = url.hostname.slice(0, -suffix.length).split(".");
  if (labels.length !== 2) return null;
  const [name, region] = labels;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(region)
    ? { name, region }
    : null;
}

function requiredEndpoint(environment: Environment, key: string): string {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required.`);
  if (value !== value.trim()) throw new Error(`${key} must be supplied as an exact origin without padding.`);
  return value;
}

function requireRemoteDevelopmentBinding(
  environment: Environment,
  backendName: string,
  siteName: string,
): void {
  const value = environment.CONVEX_DEPLOYMENT;
  const match = typeof value === "string" && value === value.trim()
    ? /^dev:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/.exec(value)
    : null;
  if (!match || match[1] !== backendName || match[1] !== siteName) {
    throw new Error("Remote admin E2E targets require CONVEX_DEPLOYMENT=dev:<deployment-name> matching both Convex origins.");
  }
}

export function resolveAdminE2ETarget(environment: Environment): AdminE2ETarget {
  if (environment.ADMIN_E2E_FIXTURE_MODE !== "true") {
    throw new Error("Admin E2E fixture mode requires ADMIN_E2E_FIXTURE_MODE=true.");
  }
  const targetEnvironment = environment.ADMIN_E2E_TARGET_ENV;
  if (targetEnvironment !== "test" && targetEnvironment !== "preview") {
    throw new Error("ADMIN_E2E_TARGET_ENV must name the test or preview target environment.");
  }
  if (environment.ADMIN_E2E_ISOLATED_TARGET_MARKER !== "isolated-admin-e2e") {
    throw new Error("ADMIN_E2E_ISOLATED_TARGET_MARKER must confirm the isolated target marker.");
  }
  if (environment.ADMIN_E2E_PROVIDER_STUB_MODE !== "true") {
    throw new Error("ADMIN_E2E_PROVIDER_STUB_MODE must be true for isolated provider transport.");
  }
  if (/^prod(?:uction)?:/i.test(environment.CONVEX_DEPLOYMENT ?? "")) {
    throw new Error("Admin E2E fixtures refuse a production Convex deployment.");
  }

  // Never consult NEXT_PUBLIC_CONVEX_* here: a developer shell may contain a
  // live app target. Fixture endpoints must always be separately explicit.
  const convexUrlValue = requiredEndpoint(environment, "ADMIN_E2E_CONVEX_URL");
  const convexSiteUrlValue = requiredEndpoint(environment, "ADMIN_E2E_CONVEX_SITE_URL");
  const convexUrl = parsedEndpoint(convexUrlValue, "ADMIN_E2E_CONVEX_URL");
  const convexSiteUrl = parsedEndpoint(convexSiteUrlValue, "ADMIN_E2E_CONVEX_SITE_URL");
  const localBackend = isLocalhost(convexUrl.hostname);
  const localSite = isLocalhost(convexSiteUrl.hostname);
  if (localBackend !== localSite) {
    throw new Error("Admin E2E Convex URLs must address the same isolated deployment.");
  }
  if (!localBackend) {
    if (convexUrl.protocol !== "https:" || convexSiteUrl.protocol !== "https:") {
      throw new Error("Remote admin E2E targets must use HTTPS.");
    }
    if (productionLooking(convexUrl) || productionLooking(convexSiteUrl)) {
      throw new Error("Admin E2E fixtures refuse production-looking target URLs.");
    }
    const backend = remoteDeployment(convexUrl, ".convex.cloud");
    const site = remoteDeployment(convexSiteUrl, ".convex.site");
    if (convexUrl.port || convexSiteUrl.port || hasExplicitPort(convexUrlValue) || hasExplicitPort(convexSiteUrlValue) || !backend || !site || backend.name !== site.name || backend.region !== site.region) {
      throw new Error("Admin E2E Convex URLs must address the same isolated deployment.");
    }
    requireRemoteDevelopmentBinding(environment, backend.name, site.name);
  }
  if (environment.BILLING_ENABLED !== "false") {
    throw new Error("Automated jurisdiction budgets require BILLING_ENABLED=false on the isolated target.");
  }
  const fixtureSecret = required(environment, "ADMIN_E2E_FIXTURE_SECRET");
  const betterAuthSecret = required(environment, "ADMIN_E2E_BETTER_AUTH_SECRET");
  const accountPassword = required(environment, "ADMIN_E2E_ACCOUNT_PASSWORD");
  requiredCanonicalSecret(environment, "ADMIN_E2E_PLACE_CLAIM_SECRET");
  const searchJurisdictionSecret = required(environment, "ADMIN_E2E_SEARCH_JURISDICTION_SECRET");
  if (fixtureSecret.length < 32 || betterAuthSecret.length < 32) {
    throw new Error("Admin E2E fixture and Better Auth secrets must each be at least 32 characters.");
  }
  if (searchJurisdictionSecret.length < 32) {
    throw new Error("ADMIN_E2E_SEARCH_JURISDICTION_SECRET must be at least 32 characters.");
  }
  if (accountPassword.length < 12) throw new Error("ADMIN_E2E_ACCOUNT_PASSWORD must be at least 12 characters.");
  const approvedCommitSha = environment.ADMIN_E2E_APPROVED_COMMIT_SHA;
  const localHeadSha = environment.ADMIN_E2E_LOCAL_HEAD_SHA;
  if (typeof approvedCommitSha !== "string"
    || typeof localHeadSha !== "string"
    || !SHA_PATTERN.test(approvedCommitSha)
    || !SHA_PATTERN.test(localHeadSha)
    || approvedCommitSha !== localHeadSha) {
    throw new Error("Admin E2E requires an exact approved/local lowercase commit SHA match.");
  }
  return {
    environment: targetEnvironment,
    convexUrl: convexUrl.origin,
    convexSiteUrl: convexSiteUrl.origin,
    fixtureSecret,
    betterAuthSecret,
    accountPassword,
    approvedCommitSha,
  };
}

function deriveLocalHeadSha(): string {
  const value = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!SHA_PATTERN.test(value)) throw new Error("Admin E2E could not derive an exact lowercase local HEAD SHA.");
  return value;
}

async function responseJson<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 512);
    throw new Error(`Admin E2E fixture ${operation} failed (${response.status}): ${detail}`);
  }
  return await response.json() as T;
}

function authorizationHeaders(secret: string) {
  return { authorization: `Bearer ${secret}`, "content-type": "application/json" };
}

export async function bootstrapAdminFixtures(options: {
  environment: Environment;
  fixtureTag: string;
  manifestPath: string;
  request?: RequestFunction;
}): Promise<FixtureManifest> {
  if (!FIXTURE_TAG_PATTERN.test(options.fixtureTag)) {
    throw new Error("Admin E2E fixture tag is invalid.");
  }
  const target = resolveAdminE2ETarget(options.environment);
  if (deriveLocalHeadSha() !== target.approvedCommitSha) {
    throw new Error("Admin E2E approved commit does not match freshly derived local HEAD.");
  }
  const request = options.request ?? fetch;
  const recoveryManifest: FixtureRecoveryManifest = {
    version: 2,
    state: "provisional",
    tag: options.fixtureTag,
    targetClass: target.environment,
    approvedCommitSha: target.approvedCommitSha,
    convexUrl: target.convexUrl,
    convexSiteUrl: target.convexSiteUrl,
    cleanupEndpoint: "/admin/e2e-fixtures/cleanup",
  };
  await mkdir(dirname(options.manifestPath), { recursive: true, mode: 0o700 });
  await writeFile(options.manifestPath, JSON.stringify(recoveryManifest), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(options.manifestPath, 0o600);
  const response = await request(`${target.convexSiteUrl}/admin/e2e-fixtures/bootstrap`, {
    method: "POST",
    headers: authorizationHeaders(target.fixtureSecret),
    body: JSON.stringify({ tag: options.fixtureTag }),
  });
  const payload = await responseJson<BootstrapResponse>(response, "bootstrap");
  if (payload.tag !== options.fixtureTag) throw new Error("Admin E2E bootstrap returned a mismatched fixture tag.");
  if (payload.providerTransport !== "stub") throw new Error("Admin E2E bootstrap did not confirm isolated provider stubs.");
  if (payload.deployedCommitSha !== target.approvedCommitSha || !SHA_PATTERN.test(payload.deployedCommitSha)) {
    throw new Error("Admin E2E bootstrap returned a mismatched deployed commit.");
  }
  if (payload.billingDisabled !== true) {
    throw new Error("Admin E2E bootstrap did not confirm billing is disabled.");
  }
  const sessions: Partial<Record<FixedRole, string>> = {};
  for (const role of FIXED_ROLES) {
    const value = payload.sessions?.[role];
    const token = value?.sessionToken;
    if (!token) throw new Error(`Admin E2E bootstrap omitted the ${role} session token.`);
    sessions[role] = `better-auth.session_token=${token}.${await makeSignature(token, target.betterAuthSecret)}`;
  }
  const variants = {} as FixtureManifest["variants"];
  for (const variant of ["normal", "noTwoFactor", "unassured"] as const) {
    const value = payload.variants?.[variant];
    if (!value?.userId || !value.sessionToken) throw new Error(`Admin E2E bootstrap omitted the ${variant} variant session.`);
    variants[variant] = {
      userId: value.userId,
      cookie: `better-auth.session_token=${value.sessionToken}.${await makeSignature(value.sessionToken, target.betterAuthSecret)}`,
    };
  }
  const jurisdictionUsers = {} as FixtureManifest["jurisdictionUsers"];
  for (const identity of ["member", "formerMember"] as const) {
    const value = payload.jurisdictionUsers?.[identity];
    if (!value?.userId || !value.sessionToken) throw new Error(`Admin E2E bootstrap omitted the ${identity} jurisdiction session.`);
    jurisdictionUsers[identity] = {
      userId: value.userId,
      cookie: `better-auth.session_token=${value.sessionToken}.${await makeSignature(value.sessionToken, target.betterAuthSecret)}`,
    };
  }
  const requiredRecordIds: Array<keyof FixtureRecords> = [
    "chatId", "resourceId", "publishedVersionId", "reviewVersionId", "separationVersionId",
    "conversationGrantId", "jurisdictionId", "userId", "stagingBucketId", "productionBucketId",
    "callbackToken", "callbackJobId", "usageUserId", "jurisdictionCountryId", "jurisdictionTownId",
    "publicOrganizationJurisdictionId", "jurisdictionMemberOnlyId", "jurisdictionMemberId", "jurisdictionFormerMemberId",
  ];
  if (!payload.records || requiredRecordIds.some((key) => typeof payload.records[key] !== "string" || !payload.records[key])) {
    throw new Error("Admin E2E bootstrap omitted required owned record identifiers.");
  }
  const manifest: FixtureManifest = {
    version: 2,
    state: "ready",
    tag: payload.tag,
    targetClass: target.environment,
    approvedCommitSha: target.approvedCommitSha,
    convexUrl: target.convexUrl,
    convexSiteUrl: target.convexSiteUrl,
    cleanupEndpoint: "/admin/e2e-fixtures/cleanup",
    sessions,
    variants,
    jurisdictionUsers,
    records: payload.records,
  };
  const completedPath = `${options.manifestPath}.${crypto.randomUUID()}.ready`;
  try {
    await writeFile(completedPath, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(completedPath, 0o600);
    await rename(completedPath, options.manifestPath);
  } finally {
    await rm(completedPath, { force: true });
  }
  return manifest;
}

export async function cleanupAdminFixtures(options: {
  environment: Environment;
  manifestPath: string;
  request?: RequestFunction;
}): Promise<void> {
  const request = options.request ?? fetch;
  try {
    const manifest = JSON.parse(await readFile(options.manifestPath, "utf8")) as FixtureRecoveryManifest;
    if (manifest.version !== 2 || !["provisional", "ready"].includes(manifest.state)
      || !FIXTURE_TAG_PATTERN.test(manifest.tag) || !manifest.convexSiteUrl) {
      throw new Error("Admin E2E recovery manifest is invalid.");
    }
    const target = resolveAdminE2ETarget(options.environment);
    if (manifest.targetClass !== target.environment
      || manifest.approvedCommitSha !== target.approvedCommitSha
      || manifest.cleanupEndpoint !== "/admin/e2e-fixtures/cleanup"
      || manifest.convexUrl !== target.convexUrl
      || manifest.convexSiteUrl !== target.convexSiteUrl) {
      throw new Error("Admin E2E manifest target does not match the guarded cleanup target.");
    }
    const response = await request(`${target.convexSiteUrl}/admin/e2e-fixtures/cleanup`, {
      method: "DELETE",
      headers: authorizationHeaders(target.fixtureSecret),
      body: JSON.stringify({ tag: manifest.tag }),
    });
    const payload = await responseJson<{ tag: string; deleted: number; cleanupConflict: boolean }>(response, "cleanup");
    if (payload.tag !== manifest.tag) throw new Error("Admin E2E cleanup returned a mismatched fixture tag.");
    if (!Number.isSafeInteger(payload.deleted) || payload.deleted < 0) {
      throw new Error("Admin E2E cleanup returned an invalid deletion count.");
    }
    if (payload.cleanupConflict !== false) {
      throw new Error("Admin E2E cleanup reported an ownership conflict; operator recovery remains required.");
    }
    await rm(options.manifestPath, { force: true });
  } catch (error) {
    // Keep the manifest as the only recovery handle when the target did not
    // confirm cleanup. It is private (0600) and lets a later teardown retry
    // the exact same tag rather than broadening cleanup scope.
    throw error;
  }
}

export function createFixtureTag(): string {
  return `e2e_${Date.now().toString(36)}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function defaultManifestPath(): string {
  return join(tmpdir(), `law-of-the-land-admin-e2e-${process.pid}-${crypto.randomUUID()}.json`);
}
