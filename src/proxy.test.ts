import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "./proxy";

describe("admin route proxy experience gate", () => {
  it("sends an unauthenticated admin request to sign in with its safe return path", async () => {
    const response = await proxy(
      new NextRequest("http://localhost/admin?section=health"),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/signin?redirect=%2Fadmin%3Fsection%3Dhealth",
    );
  });

  it("passes an admin path to the server layout through a proxy-owned header", async () => {
    const request = new NextRequest("http://localhost/admin/forbidden", {
      headers: {
        cookie: "better-auth.session_token=placeholder-session",
        "x-admin-pathname": "/admin/spoofed",
      },
    });

    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-request-x-admin-pathname")).toBe(
      "/admin/forbidden",
    );
  });
});
