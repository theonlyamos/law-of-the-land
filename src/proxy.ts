import {
  convexAuthNextjsMiddleware,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";

const UUID_V4_RE =
  /^\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isChatRoute(pathname: string) {
  return UUID_V4_RE.test(pathname);
}

function isSettingsRoute(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

export const proxy = convexAuthNextjsMiddleware(
  async (request, { convexAuth }) => {
    const isAuthenticated = await convexAuth.isAuthenticated();
    const { pathname, search } = request.nextUrl;

    if (pathname === "/signin" && isAuthenticated) {
      const redirectTo = request.nextUrl.searchParams.get("redirect") ?? "/";
      return nextjsMiddlewareRedirect(request, redirectTo);
    }

    if ((isChatRoute(pathname) || isSettingsRoute(pathname)) && !isAuthenticated) {
      const signInUrl = new URL("/signin", request.url);
      signInUrl.searchParams.set("redirect", pathname + search);
      return nextjsMiddlewareRedirect(request, signInUrl.pathname + signInUrl.search);
    }
  },
  {
    cookieConfig: {
      maxAge: 60 * 60 * 24 * 30,
    },
  }
);

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
