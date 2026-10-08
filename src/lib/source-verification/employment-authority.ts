import { makeFunctionReference } from "convex/server";
import { z } from "zod";
import type { Id } from "../../../convex/_generated/dataModel";
import { isGeminiFileSearchStoreName } from "../../../convex/lib/geminiFileSearchNames";
import { PILOT_CATALOG, PILOT_IDENTITY } from "./reviewed-source-cases";
import { captureReviewedEmploymentPolicy, REVIEWED_EMPLOYMENT_POLICY,
  type ReviewedEmploymentPolicy } from "../../../shared/reviewed-employment-policy";
import type { ReviewedSourceAuthorityReason as LocalPilotAuthorityReason, ReviewedSourceAuthorityResult as LocalPilotAuthorityResult } from "./reviewed-authority-contract";
import { captureTrustedTimingPolicy, type TrustedTimingPolicy } from "./trusted-timing-policy";

export type EmploymentAuthorizationArgs = {
  externalId: string; jurisdictionId: Id<"jurisdictions">; resourceId: Id<"legalResources">;
  versionId: Id<"documentVersions">; expectedSha256: string; expectedByteSize: number; asOfDate: string;
};
export const employmentAuthorizationReference = makeFunctionReference<"query", EmploymentAuthorizationArgs, unknown>("reviewedEmployment:authorizeSource");
export type EmploymentAuthorityInput = Readonly<{
  externalId: string; jurisdictionId: string;
  sources: readonly Readonly<{ sourceId: string; versionId: string }>[];
  deadlineAt: number; signal: AbortSignal;
}>;
export type EmploymentAuthorityDependencies = Readonly<{
  /** Pinned catalog supplied by trusted deployment construction, never the browser. */
  catalog?: ReviewedEmploymentPolicy;
  timingPolicy?: TrustedTimingPolicy;
  /** Use the current user's authenticated public query, never an admin client. */
  authorizeSource(input: Readonly<EmploymentAuthorizationArgs & { signal: AbortSignal }>): Promise<unknown>;
  /** The existing authenticated private research manifest remains server-only. */
  loadManifest(input: Readonly<{ jurisdictionId: string; deadlineAt: number; signal: AbortSignal }>): Promise<unknown>;
}>;
export type EmploymentAuthorityResult = LocalPilotAuthorityResult;

const id = z.string().min(1).max(128);
const inputSchema = z.object({ externalId: z.string().min(1).max(256).refine(value => value.trim() === value && value.length > 0),
  jurisdictionId: id,
  sources: z.array(z.object({ sourceId: z.literal(PILOT_IDENTITY.sourceId), versionId: z.literal(PILOT_IDENTITY.versionId) })).length(1),
  deadlineAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const nullableDate = z.string().max(10).nullable();
const grantSchema = z.strictObject({ status: z.literal("authorized"), externalId: z.string().min(1).max(256),
  jurisdictionId: id, resourceId: id,
  versionId: id, sha256: z.literal(PILOT_IDENTITY.originalSha256),
  byteSize: z.literal(PILOT_IDENTITY.originalByteLength), asOfDate: z.string().length(10),
  resourceEffectiveDate: nullableDate, resourceRepealDate: nullableDate,
  versionEffectiveDate: nullableDate, versionRepealDate: nullableDate });
const manifestSchema = z.strictObject({ authorizedScopeSize: z.number().int().min(1).max(32), partialCoverage: z.boolean(),
  stores: z.array(z.strictObject({ jurisdictionId: id,
    name: z.string().min(1).max(200).refine(value => value.trim().length > 0),
    kind: z.enum(["geographic", "organizational"]), relation: z.enum(["selected", "geographic_ancestor", "organizational_geography"]),
    storeName: z.string().max(200).refine(isGeminiFileSearchStoreName) })).min(1).max(32) });

const unavailable = (reason: LocalPilotAuthorityReason): EmploymentAuthorityResult =>
  Object.freeze({ status: "unavailable", reason, productionEligible: false });
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function applicable(effective: string | null, repeal: string | null, today: string): boolean {
  return (effective === null || (validDate(effective) && effective <= today))
    && (repeal === null || (validDate(repeal) && repeal > today));
}

/** The fixed reviewed edition can be selected only after a fresh normal-user
 * session grant and a fresh research manifest. No registry entry is itself an
 * authorization, and this result never certifies current law or full coverage.
 * Resolve again before final completion; completion and claim consumption still
 * provide the authoritative publication/session/citation checks before release.
 */
export function createEmploymentAuthority(dependencies?: EmploymentAuthorityDependencies) {
  const policy = captureReviewedEmploymentPolicy(dependencies?.catalog ?? REVIEWED_EMPLOYMENT_POLICY);
  const catalog = policy ? Object.freeze({ jurisdictionId: policy.jurisdictionId, resourceId: policy.resourceId, versionId: policy.versionId }) : null;
  const timing = captureTrustedTimingPolicy(dependencies?.timingPolicy);
  const authorizeSource = dependencies?.authorizeSource, loadManifest = dependencies?.loadManifest;
  return Object.freeze({ async resolve(input: EmploymentAuthorityInput): Promise<EmploymentAuthorityResult> {
    if (!timing || !catalog) return unavailable("invalid_request");
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success || parsed.data.jurisdictionId !== catalog.jurisdictionId || !(input.signal instanceof AbortSignal)) return unavailable("invalid_request");
    const { externalId, deadlineAt } = parsed.data, callerSignal = input.signal;
    if (callerSignal.aborted) return unavailable("aborted");
    if (Date.now() >= deadlineAt) return unavailable("deadline_exceeded");
    if (deadlineAt - Date.now() > timing.authorityMs) return unavailable("invalid_deadline");
    if (typeof authorizeSource !== "function" || typeof loadManifest !== "function") return unavailable("authority_unavailable");
    const admittedMono = performance.now();
    if (timing.verificationMs === 240000 && !Number.isFinite(admittedMono)) return unavailable("invalid_deadline");
    const monotonicLimit = admittedMono + (deadlineAt - Date.now());
    const remaining = () => Math.min(deadlineAt - Date.now(), timing.verificationMs === 240000 ? monotonicLimit - performance.now() : Infinity);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
    const stopped = (): "aborted" | "deadline_exceeded" | undefined => remaining() <= 0
      ? "deadline_exceeded" : callerSignal.aborted || controller.signal.aborted ? "aborted" : undefined;
    try {
      const cancelled = new Promise<EmploymentAuthorityResult>(resolve => {
        const cancel = () => { resolve(unavailable(stopped() ?? "aborted")); controller.abort(); };
        onAbort = cancel; callerSignal.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(cancel, Math.max(0, remaining()));
        if (callerSignal.aborted) cancel();
      });
      const work = async (): Promise<EmploymentAuthorityResult> => {
        try {
          let stop = stopped(); if (stop) return unavailable(stop);
          const today = new Date(Date.now()).toISOString().slice(0, 10);
          const grant = grantSchema.safeParse(await authorizeSource({ externalId,
            jurisdictionId: catalog.jurisdictionId as Id<"jurisdictions">,
            resourceId: catalog.resourceId as Id<"legalResources">,
            versionId: catalog.versionId as Id<"documentVersions">,
            expectedSha256: PILOT_IDENTITY.originalSha256, expectedByteSize: PILOT_IDENTITY.originalByteLength,
            asOfDate: today, signal: controller.signal }));
          stop = stopped(); if (stop) return unavailable(stop);
          if (!grant.success || grant.data.externalId !== externalId || grant.data.asOfDate !== today
            || !Object.entries(catalog).every(([key, value]) => grant.data[key as keyof typeof catalog] === value)) return unavailable("catalog_mismatch");
          if (!applicable(grant.data.resourceEffectiveDate, grant.data.resourceRepealDate, today)
            || !applicable(grant.data.versionEffectiveDate, grant.data.versionRepealDate, today)) return unavailable("source_not_applicable");
          const parsedManifest = manifestSchema.safeParse(await loadManifest({ jurisdictionId: catalog.jurisdictionId,
            deadlineAt, signal: controller.signal }));
          stop = stopped(); if (stop) return unavailable(stop);
          // A date boundary invalidates this grant; never extend the deadline to retry.
          if (new Date(Date.now()).toISOString().slice(0, 10) !== today) return unavailable("source_not_applicable");
          if (!parsedManifest.success) return unavailable("manifest_invalid");
          const manifest = parsedManifest.data, selected = manifest.stores[0];
          if (selected.jurisdictionId !== catalog.jurisdictionId || selected.relation !== "selected"
            || selected.kind !== "geographic" || manifest.stores.some((store, index) => index > 0 && store.relation === "selected")
            || manifest.authorizedScopeSize < manifest.stores.length
            || manifest.partialCoverage !== (manifest.authorizedScopeSize !== manifest.stores.length)
            || new Set(manifest.stores.map(store => store.jurisdictionId)).size !== manifest.stores.length
            || new Set(manifest.stores.map(store => store.storeName)).size !== manifest.stores.length) return unavailable("manifest_invalid");
          for (const store of manifest.stores) Object.freeze(store);
          Object.freeze(manifest.stores); Object.freeze(manifest);
          return Object.freeze({ status: "authorized", identities: Object.freeze([Object.freeze({ ...PILOT_IDENTITY })]), manifest,
            citationIdentity: Object.freeze({ ...catalog, providerStoreName: selected.storeName }),
            applicability: "source_edition_only", requiresFinalAtomicCompletion: true, productionEligible: false });
        } catch { return unavailable(stopped() ?? "authority_unavailable"); }
      };
      // Consume late errors and free the waiter even if the injected I/O ignores abort.
      return await Promise.race([work(), cancelled]);
    } catch { return unavailable(stopped() ?? "authority_unavailable"); }
    finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) callerSignal.removeEventListener("abort", onAbort);
    }
  } });
}
