import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmploymentAuthority, employmentAuthorizationReference, type EmploymentAuthorityInput } from "./employment-authority";
import { PILOT_CATALOG, PILOT_IDENTITY } from "./reviewed-source-cases";
import { PRODUCTION_REVIEWED_EMPLOYMENT_POLICY } from "../../../shared/reviewed-employment-policy";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const storeName = "fileSearchStores/employment-current";
function request(patch: Partial<EmploymentAuthorityInput> = {}): EmploymentAuthorityInput {
  return { externalId: "normal-owned-chat", jurisdictionId: PILOT_CATALOG.jurisdictionId,
    sources: [{ sourceId: PILOT_IDENTITY.sourceId, versionId: PILOT_IDENTITY.versionId }],
    deadlineAt: NOW + 30_000, signal: new AbortController().signal, ...patch };
}
function grant() {
  return { status: "authorized", externalId: "normal-owned-chat", ...PILOT_CATALOG,
    sha256: PILOT_IDENTITY.originalSha256, byteSize: PILOT_IDENTITY.originalByteLength,
    asOfDate: "2026-10-05", resourceEffectiveDate: "2003-10-08", resourceRepealDate: null,
    versionEffectiveDate: null, versionRepealDate: null };
}
function manifest() {
  return { authorizedScopeSize: 1, partialCoverage: false, stores: [{ jurisdictionId: PILOT_CATALOG.jurisdictionId,
    name: "Ghana", kind: "geographic", relation: "selected", storeName }] };
}
function dependencies() {
  return { authorizeSource: vi.fn(async () => grant() as unknown), loadManifest: vi.fn(async () => manifest() as unknown) };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("normal employment authority adapter", () => {
  it("retains a strict published-document filter and opts into capable source authority", async () => {
    const deps = dependencies();
    const publicationFilter = { protocol: "published-v1", environment: "production", documents: [
      { resourceId: PILOT_CATALOG.resourceId, versionId: PILOT_CATALOG.versionId, sha256: PILOT_IDENTITY.originalSha256 },
    ] };
    deps.loadManifest.mockResolvedValue({ ...manifest(), stores: [{ ...manifest().stores[0], publicationFilter }] });
    const result = await createEmploymentAuthority(deps).resolve(request());
    expect(result).toMatchObject({ status: "authorized", manifest: { stores: [{ publicationFilter }] } });
    expect(deps.authorizeSource).toHaveBeenCalledWith(expect.objectContaining({ publicationFilterProtocol: "published-v1" }));
    expect(deps.loadManifest).toHaveBeenCalledWith(expect.objectContaining({ publicationFilterProtocol: "published-v1" }));
  });

  it("does not authorize the reviewed edition when the allowlist excludes its exact bytes", async () => {
    const deps = dependencies();
    deps.loadManifest.mockResolvedValue({ ...manifest(), stores: [{ ...manifest().stores[0], publicationFilter: {
      protocol: "published-v1", environment: "production", documents: [
        { resourceId: PILOT_CATALOG.resourceId, versionId: PILOT_CATALOG.versionId, sha256: "a".repeat(64) },
      ],
    } }] });
    expect(await createEmploymentAuthority(deps).resolve(request())).toMatchObject({ status: "unavailable", reason: "manifest_invalid" });
  });
  it("binds the unchanged reviewed bytes to the production edition supplied by trusted server construction", async () => {
    const policy = PRODUCTION_REVIEWED_EMPLOYMENT_POLICY;
    const catalog = { jurisdictionId: policy.jurisdictionId, resourceId: policy.resourceId, versionId: policy.versionId };
    const deps = dependencies();
    deps.authorizeSource.mockResolvedValue({ ...grant(), ...catalog });
    deps.loadManifest.mockResolvedValue({ ...manifest(), stores: [{ ...manifest().stores[0], jurisdictionId: policy.jurisdictionId }] });
    const result = await createEmploymentAuthority({ ...deps, catalog: policy }).resolve(request({ jurisdictionId: policy.jurisdictionId }));
    expect(result).toMatchObject({ status: "authorized", identities: [PILOT_IDENTITY], citationIdentity: { ...catalog, providerStoreName: storeName } });
    expect(deps.authorizeSource).toHaveBeenCalledWith({ externalId: "normal-owned-chat", ...catalog,
      expectedSha256: PILOT_IDENTITY.originalSha256, expectedByteSize: PILOT_IDENTITY.originalByteLength,
      asOfDate: "2026-10-05", signal: expect.any(AbortSignal), publicationFilterProtocol: "published-v1" });
  });
  it("rejects a DEV catalog grant when the trusted server selected the production edition", async () => {
    const deps = dependencies();
    expect(await createEmploymentAuthority({ ...deps, catalog: PRODUCTION_REVIEWED_EMPLOYMENT_POLICY }).resolve(
      request({ jurisdictionId: PRODUCTION_REVIEWED_EMPLOYMENT_POLICY.jurisdictionId })))
      .toMatchObject({ status: "unavailable", reason: "catalog_mismatch" });
    expect(deps.loadManifest).not.toHaveBeenCalled();
  });
  it("accepts the original background verification deadline above 90 seconds through a trusted server policy", async () => {
    const deps = dependencies();
    expect(await createEmploymentAuthority({ ...deps, timingPolicy: "background" }).resolve(request({ deadlineAt: NOW + 240_000 })))
      .toMatchObject({ status: "authorized" });
    expect(deps.loadManifest).toHaveBeenCalledWith({ jurisdictionId: PILOT_CATALOG.jurisdictionId,
      deadlineAt: NOW + 240_000, signal: expect.any(AbortSignal), publicationFilterProtocol: "published-v1" });
  });

  it.each([null, "unknown", 240_000])("rejects an invalid trusted authority timing policy %s before querying", async timingPolicy => {
    const deps = dependencies();
    expect(await createEmploymentAuthority({ ...deps, timingPolicy: timingPolicy as never }).resolve(request()))
      .toMatchObject({ status: "unavailable", reason: "invalid_request" });
    expect(deps.authorizeSource).not.toHaveBeenCalled(); expect(deps.loadManifest).not.toHaveBeenCalled();
  });

  it("refuses background authority deadlines beyond 240 seconds", async () => {
    const deps = dependencies();
    expect(await createEmploymentAuthority({ ...deps, timingPolicy: "background" }).resolve(request({ deadlineAt: NOW + 240_001 })))
      .toMatchObject({ status: "unavailable", reason: "invalid_deadline" });
    expect(deps.authorizeSource).not.toHaveBeenCalled(); expect(deps.loadManifest).not.toHaveBeenCalled();
  });
  it("binds the fixed reviewed edition to a current ordinary-user grant and private manifest", async () => {
    const deps = dependencies();
    const result = await createEmploymentAuthority(deps).resolve(request());
    expect(getFunctionName(employmentAuthorizationReference)).toBe("reviewedEmployment:authorizeSource");
    expect(deps.authorizeSource).toHaveBeenCalledWith({ externalId: "normal-owned-chat", ...PILOT_CATALOG,
      expectedSha256: PILOT_IDENTITY.originalSha256, expectedByteSize: PILOT_IDENTITY.originalByteLength,
      asOfDate: "2026-10-05", signal: expect.any(AbortSignal), publicationFilterProtocol: "published-v1" });
    expect(deps.loadManifest).toHaveBeenCalledWith({ jurisdictionId: PILOT_CATALOG.jurisdictionId,
      deadlineAt: NOW + 30_000, signal: expect.any(AbortSignal), publicationFilterProtocol: "published-v1" });
    expect(result).toEqual({ status: "authorized", identities: [PILOT_IDENTITY], manifest: manifest(),
      citationIdentity: { ...PILOT_CATALOG, providerStoreName: storeName }, applicability: "source_edition_only",
      requiresFinalAtomicCompletion: true, productionEligible: false });
    if (result.status !== "authorized") throw new Error("Expected authorized source");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.identities[0])).toBe(true);
    expect(Object.isFrozen(result.manifest.stores[0])).toBe(true);
  });

  it.each([
    { jurisdictionId: "different-jurisdiction" }, { externalId: " " }, { externalId: "x".repeat(257) },
    { sources: [{ sourceId: "other-reviewed-source", versionId: PILOT_IDENTITY.versionId }] },
    { sources: [{ sourceId: PILOT_IDENTITY.sourceId, versionId: "other-version" }] },
    { sources: [] }, { deadlineAt: NOW }, { deadlineAt: NOW + 90_001 },
  ])("rejects invalid/out-of-scope input before querying %j", async patch => {
    const deps = dependencies();
    expect(await createEmploymentAuthority(deps).resolve(request(patch))).toMatchObject({ status: "unavailable" });
    expect(deps.authorizeSource).not.toHaveBeenCalled();
    expect(deps.loadManifest).not.toHaveBeenCalled();
  });

  it.each([
    { status: "unavailable" }, { externalId: "somebody-else-chat" }, { jurisdictionId: "other-jurisdiction" },
    { resourceId: "other-resource" }, { versionId: "other-version" }, { sha256: "a".repeat(64) }, { byteSize: 10 },
    { asOfDate: "2026-10-04" }, { resourceEffectiveDate: "2026-10-06" }, { resourceRepealDate: "2026-10-05" },
    { versionEffectiveDate: "2026-10-06" }, { versionRepealDate: "2026-10-05" }, { versionEffectiveDate: "2026-02-30" },
    { storageId: "private-storage-id" }, { providerDocumentName: "fileSearchStores/private/documents/file" },
  ])("closes invalid or stale grants before loading manifest %j", async patch => {
    const deps = dependencies();
    deps.authorizeSource.mockResolvedValue({ ...grant(), ...patch });
    expect(await createEmploymentAuthority(deps).resolve(request())).toMatchObject({ status: "unavailable" });
    expect(deps.loadManifest).not.toHaveBeenCalled();
  });

  it.each([
    { authorizedScopeSize: 0 }, { authorizedScopeSize: 2, partialCoverage: false }, { partialCoverage: true },
    { stores: [] }, { stores: [{ ...manifest().stores[0], relation: "geographic_ancestor" }] },
    { stores: [{ ...manifest().stores[0], jurisdictionId: "another-jurisdiction" }] },
    { stores: [{ ...manifest().stores[0], kind: "organizational" }] },
    { stores: [{ ...manifest().stores[0], storeName: "not-a-store" }] },
    { authorizedScopeSize: 2, stores: [manifest().stores[0], manifest().stores[0]] },
  ])("closes inconsistent private research manifests %j", async patch => {
    const deps = dependencies(); deps.loadManifest.mockResolvedValue({ ...manifest(), ...patch });
    expect(await createEmploymentAuthority(deps).resolve(request())).toMatchObject({ status: "unavailable", reason: "manifest_invalid" });
  });

  it("reads fresh authorization on every resolve, including revocation", async () => {
    const deps = dependencies(), authority = createEmploymentAuthority(deps);
    expect(await authority.resolve(request())).toMatchObject({ status: "authorized" });
    deps.authorizeSource.mockResolvedValue({ status: "unavailable" });
    expect(await authority.resolve(request())).toMatchObject({ status: "unavailable" });
    expect(deps.authorizeSource).toHaveBeenCalledTimes(2);
    expect(deps.loadManifest).toHaveBeenCalledTimes(1);
  });

  it("does not let a caller mutation during manifest loading change the checked grant", async () => {
    const deps = dependencies(), shared = { ...grant(), versionId: String(PILOT_CATALOG.versionId) };
    deps.authorizeSource.mockResolvedValue(shared);
    deps.loadManifest.mockImplementation(async () => { shared.versionId = "caller-mutation"; return manifest(); });
    const result = await createEmploymentAuthority(deps).resolve(request());
    expect(result).toMatchObject({ status: "authorized", citationIdentity: PILOT_CATALOG });
  });

  it("closes when the current UTC date changes before returning the grant", async () => {
    vi.setSystemTime(Date.parse("2026-10-05T23:59:59Z"));
    const deps = dependencies(); deps.loadManifest.mockImplementation(async () => {
      vi.setSystemTime(Date.parse("2026-10-06T00:00:01Z")); return manifest();
    });
    expect(await createEmploymentAuthority(deps).resolve(request({ deadlineAt: Date.now() + 30_000 })))
      .toMatchObject({ status: "unavailable" });
  });

  it("closes before any callback when already aborted", async () => {
    const deps = dependencies(), controller = new AbortController(); controller.abort();
    expect(await createEmploymentAuthority(deps).resolve(request({ signal: controller.signal })))
      .toMatchObject({ status: "unavailable", reason: "aborted" });
    expect(deps.authorizeSource).not.toHaveBeenCalled();
  });

  it("returns at the original deadline even if the query ignores cancellation and rejects late", async () => {
    const deps = dependencies();
    let rejectQuery!: (reason: Error) => void;
    deps.authorizeSource.mockImplementation(() => new Promise((_resolve, reject) => { rejectQuery = reject; }));
    const pending = createEmploymentAuthority(deps).resolve(request({ deadlineAt: NOW + 5 }));
    await vi.advanceTimersByTimeAsync(5);
    expect(await pending).toMatchObject({ status: "unavailable", reason: "deadline_exceeded" });
    rejectQuery(new Error("private backend error")); await Promise.resolve();
    expect(deps.loadManifest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes when caller aborts during a hanging manifest", async () => {
    const deps = dependencies(), controller = new AbortController();
    deps.loadManifest.mockImplementation(() => new Promise(() => undefined));
    const pending = createEmploymentAuthority(deps).resolve(request({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    expect(await pending).toMatchObject({ status: "unavailable", reason: "aborted" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes unavailable dependencies and exceptions without forwarding private messages", async () => {
    expect(await createEmploymentAuthority().resolve(request())).toMatchObject({ status: "unavailable" });
    const deps = dependencies(); deps.authorizeSource.mockRejectedValue(new Error("private provider configuration"));
    expect(await createEmploymentAuthority(deps).resolve(request())).toEqual({ status: "unavailable", reason: "authority_unavailable", productionEligible: false });
  });
});



describe("background authority cancellation", () => {
  it("captures its original wall allowance once and withholds after monotonic expiry during wall rollback", async () => {
    let mono = 1000; vi.spyOn(performance, "now").mockImplementation(() => mono);
    const deps = dependencies(); deps.authorizeSource.mockImplementation(async () => {
      mono += 200_000; vi.setSystemTime(NOW - 1000); return grant();
    });
    expect(await createEmploymentAuthority({ ...deps, timingPolicy: "background" }).resolve(request({ deadlineAt: NOW + 200_000 })))
      .toMatchObject({ status: "unavailable", reason: "deadline_exceeded" });
    expect(deps.loadManifest).not.toHaveBeenCalled();
  });
});
