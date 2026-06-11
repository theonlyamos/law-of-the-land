/**
 * Restrict redirect targets to same-origin paths. Absolute URLs and
 * protocol-relative values ("//evil.com", "/\evil.com") fall back to the
 * given fallback path.
 */
export function safeRedirectPath(
  value: string | null | undefined,
  fallback: string = "/"
): string {
  if (!value) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}
