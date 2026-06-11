import { Polar } from "@convex-dev/polar";
import { api, components } from "./_generated/api";

/**
 * Billing client. Requires on the Convex deployment:
 * - POLAR_ORGANIZATION_TOKEN, POLAR_WEBHOOK_SECRET, POLAR_SERVER
 * - POLAR_PRO_MONTHLY_PRODUCT_ID (the Pro product created in the Polar dashboard)
 *
 * Subscription reads work without these (they query synced data); checkout and
 * portal actions fail with a clear error until they are configured.
 */
export const polar = new Polar(components.polar, {
  getUserInfo: async (ctx): Promise<{ userId: string; email: string }> => {
    // Annotated to break type circularity (polar.api() feeds back into `api`).
    const user: { id: string; email: string | null } | null = await ctx.runQuery(
      api.users.current,
      {}
    );
    if (!user?.email) {
      throw new Error("Sign in to manage billing.");
    }
    return { userId: user.id, email: user.email };
  },
  products: {
    proMonthly: process.env.POLAR_PRO_MONTHLY_PRODUCT_ID ?? "",
  },
});

export const {
  getConfiguredProducts,
  generateCheckoutLink,
  generateCustomerPortalUrl,
  cancelCurrentSubscription,
} = polar.api();
