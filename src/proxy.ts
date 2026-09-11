import { NextRequest, NextResponse } from "next/server";
import { applicationOrigin, publicWidgetConfig } from "@/lib/embed/server";
import { getSessionCookie } from "better-auth/cookies";

const UUID_V4_RE =
  /^\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isChatRoute(pathname: string) {
  return pathname === "/new" || UUID_V4_RE.test(pathname);
}

function isSettingsRoute(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

function isAdminRoute(pathname: string) {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

function accountResponse(response: NextResponse) {
  response.headers.set("Content-Security-Policy", "frame-ancestors 'self'");
  response.headers.set("X-Frame-Options", "SAMEORIGIN");
  return response;
}
export async function proxy(request: NextRequest) {

  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/embed/")) {
    const id = pathname.slice(7);
    const config = process.env.WIDGET_CHAT_ENABLED === "true" ? await publicWidgetConfig(id, request.nextUrl.searchParams.get("parentOrigin") ?? "").catch(() => null) : null;
    const response = config ? NextResponse.next() : new NextResponse("This assistant is unavailable.", { status: 404 });
    response.headers.set("Content-Security-Policy", `frame-ancestors ${config ? [applicationOrigin(request), ...config.allowedOrigins].join(" ") : "'none'"}`);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    return response;
  }
  if (pathname.startsWith("/api/embed/")) return NextResponse.next();
  const sessionCookie = getSessionCookie(request);

  if (
    (isChatRoute(pathname) ||
      isSettingsRoute(pathname) ||
      isAdminRoute(pathname) || pathname.startsWith("/organizations")) &&
    !sessionCookie
  ) {
    const signInUrl = new URL("/signin", request.url);
    signInUrl.searchParams.set("redirect", pathname + search);
    return accountResponse(NextResponse.redirect(signInUrl));
  }

  if (isAdminRoute(pathname)) {
    const requestHeaders = new Headers(request.headers);
    // Always overwrite caller input so the server layout can safely exempt
    // only the static forbidden destination from its redirecting guard.
    requestHeaders.set("x-admin-pathname", pathname);
    return accountResponse(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  return accountResponse(NextResponse.next());
}

export const config = {
  matcher: ["/((?!.*\\..*|_next|api/auth).*)", "/", "/(api|trpc)(.*)"],
};
