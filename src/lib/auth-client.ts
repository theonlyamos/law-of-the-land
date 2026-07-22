import { createAuthClient } from "better-auth/react";
import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { adminClient, twoFactorClient } from "better-auth/client/plugins";
import {
  adminAccessControl,
  betterAuthAdminRoles,
} from "@/convex/lib/adminPermissions";

export const authClient = createAuthClient({
  plugins: [
    adminClient({ ac: adminAccessControl, roles: betterAuthAdminRoles }),
    twoFactorClient(),
    convexClient(),
  ],
});
