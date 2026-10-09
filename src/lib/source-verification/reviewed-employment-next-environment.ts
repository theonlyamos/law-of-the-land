type Environment = Readonly<Record<string, string | undefined>>;

/** Next substitutes only explicit public-variable references at build time.
 * Keep those URLs bound to the artifact, while native deployment and rollback
 * selectors remain fresh. Conflicting native public URLs invalidate the binding.
 * This whitelist deliberately excludes credentials and unrelated environment data.
 */
export function reviewedEmploymentNextEnvironment(runtime: Environment = process.env): Environment {
  const cloud = process.env.NEXT_PUBLIC_CONVEX_URL;
  const site = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  const urlsMatch = (runtime.NEXT_PUBLIC_CONVEX_URL === undefined || runtime.NEXT_PUBLIC_CONVEX_URL === cloud)
    && (runtime.NEXT_PUBLIC_CONVEX_SITE_URL === undefined || runtime.NEXT_PUBLIC_CONVEX_SITE_URL === site);
  return Object.freeze({
    NODE_ENV: runtime.NODE_ENV,
    VERCEL: runtime.VERCEL,
    VERCEL_ENV: runtime.VERCEL_ENV,
    CONVEX_DEPLOYMENT: runtime.CONVEX_DEPLOYMENT,
    NEXT_PUBLIC_CONVEX_URL: urlsMatch ? cloud : undefined,
    NEXT_PUBLIC_CONVEX_SITE_URL: urlsMatch ? site : undefined,
    LOCAL_REVIEWED_EMPLOYMENT_ENABLED: runtime.LOCAL_REVIEWED_EMPLOYMENT_ENABLED,
    LOCAL_REVIEWED_EMPLOYMENT_BACKGROUND_ENABLED: runtime.LOCAL_REVIEWED_EMPLOYMENT_BACKGROUND_ENABLED,
    LOCAL_REVIEWED_EMPLOYMENT_SPLIT_ENABLED: runtime.LOCAL_REVIEWED_EMPLOYMENT_SPLIT_ENABLED,
    LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED: runtime.LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED,
    REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED: runtime.REVIEWED_EMPLOYMENT_PRODUCTION_ADMISSION_ENABLED,
    REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED: runtime.REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED,
  });
}
