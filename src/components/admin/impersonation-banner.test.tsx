import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImpersonationBannerView } from "./impersonation-banner";

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: null }),
    admin: { stopImpersonating: vi.fn() },
  },
}));

afterEach(cleanup);

describe("impersonation banner", () => {
  it("keeps the impersonated state visible and offers a reliable end action", () => {
    const onEnd = vi.fn();
    render(
      <ImpersonationBannerView
        expiresAt={Date.now() + 15 * 60_000}
        onEnd={onEnd}
        ending={false}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "You are viewing the site as another user",
    );
    fireEvent.click(screen.getByRole("button", { name: "End impersonation" }));
    expect(onEnd).toHaveBeenCalledOnce();
  });
});
