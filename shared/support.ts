/** Contract shared by the public contact form, Convex, and the admin inbox. */

export const SUPPORT_CATEGORIES = [
  "support",
  "bug",
  "feature_request",
  "complaint",
  "other",
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const SUPPORT_CATEGORY_LABELS: Record<SupportCategory, string> = {
  support: "Help with my account or a question",
  bug: "Something isn't working",
  feature_request: "Feature request",
  complaint: "Complaint",
  other: "Something else",
};

export const SUPPORT_CATEGORY_SHORT_LABELS: Record<SupportCategory, string> = {
  support: "Support",
  bug: "Bug",
  feature_request: "Feature request",
  complaint: "Complaint",
  other: "Other",
};

export const SUPPORT_STATUSES = ["new", "in_progress", "resolved", "closed"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const SUPPORT_STATUS_LABELS: Record<SupportStatus, string> = {
  new: "New",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

export const SUPPORT_LIMITS = {
  subjectMin: 3,
  subjectMax: 150,
  messageMin: 10,
  messageMax: 5_000,
  nameMax: 100,
  emailMax: 254,
  pagePathMax: 500,
  userAgentMax: 500,
  noteMax: 2_000,
  screenshotMaxBytes: 5 * 1024 * 1024,
} as const;

export const SUPPORT_SCREENSHOT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export function isAcceptableSupportScreenshot(file: { contentType?: string; size: number }): boolean {
  return (
    (SUPPORT_SCREENSHOT_TYPES as readonly string[]).includes(file.contentType ?? "") &&
    file.size > 0 &&
    file.size <= SUPPORT_LIMITS.screenshotMaxBytes
  );
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidSupportEmail(value: string): boolean {
  return value.length <= SUPPORT_LIMITS.emailMax && EMAIL_PATTERN.test(value);
}

/**
 * Only same-site paths are kept, so a link back to the page a user came from
 * can never point at another origin.
 */
export function normalizeSupportPagePath(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\")) return undefined;
  if (trimmed.length > SUPPORT_LIMITS.pagePathMax) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

/** A short, human-friendly reference users can quote back to support. */
export function supportReference(ticketId: string): string {
  return ticketId.slice(-8).toUpperCase();
}
