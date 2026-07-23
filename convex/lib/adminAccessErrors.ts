import { ConvexError } from "convex/values";

export const ADMIN_ACCESS_CODES = [
  "ADMIN_AUTH_REQUIRED",
  "ADMIN_2FA_REQUIRED",
  "ADMIN_FORBIDDEN",
  "ADMIN_DISABLED",
] as const;

export type AdminAccessCode = (typeof ADMIN_ACCESS_CODES)[number];

export type AdminAccessErrorData = {
  code: AdminAccessCode;
  message: string;
};

export function isAdminAccessCode(value: unknown): value is AdminAccessCode {
  return (
    typeof value === "string" &&
    (ADMIN_ACCESS_CODES as readonly string[]).includes(value)
  );
}

export function adminAccessError(
  code: AdminAccessCode,
  message: string,
): ConvexError<AdminAccessErrorData> {
  return new ConvexError({ code, message });
}
