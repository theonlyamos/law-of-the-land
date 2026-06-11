import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { safeRedirectPath } from "@/lib/redirect";

const UUID_V4_RE =
  /^\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isChatRoute(pathname: string) {
  return pathname === "/new" || UUID_V4_RE.test(pathname);
}

function isSettingsRoute(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

export async function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  const { pathname, search } = request.nextUrl;

  if (pathname === "/signin" && sessionCookie) {
    const redirectTo = safeRedirectPath(request.nextUrl.searchParams.get("redirect"), "/new");
    return NextResponse.redirect(new URL(redirectTo, request.url));
  }

  if ((isChatRoute(pathname) || isSettingsRoute(pathname)) && !sessionCookie) {
    const signInUrl = new URL("/signin", request.url);
    signInUrl.searchParams.set("redirect", pathname + search);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!.*\\..*|_next|api/auth).*)", "/", "/(api|trpc)(.*)"],
};
