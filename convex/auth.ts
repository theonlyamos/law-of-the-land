import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { admin } from "better-auth/plugins/admin";
import { twoFactor } from "better-auth/plugins/two-factor";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";
import authSchema from "./betterAuth/schema";
import {
  ADMIN_ROLES,
  adminAccessControl,
  betterAuthAdminRoles,
  parseAdminRoles,
} from "./lib/adminPermissions";
import { sendEmail } from "./lib/email";

const siteUrl = process.env.SITE_URL!;

export const authComponent = createClient<DataModel, typeof authSchema>(
  components.betterAuth,
  { local: { schema: authSchema } },
);

export function isGuardedAdminPluginRoute(path: string): boolean {
  return path.startsWith("/admin/") && path !== "/admin/stop-impersonating";
}

export function isOAuthCallbackRoute(path: string): boolean {
  return path === "/callback/:id" || path.startsWith("/callback/");
}

export const createAuthOptions = (ctx: GenericCtx<DataModel>) =>
  ({
    baseURL: siteUrl,
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
        ...coreFields,
        role: "user",
        banned: false,
        banReason: null,
        banExpires: null,
        ...additionalFields,
        id,
      }),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail({
          to: user.email,
          subject: "Verify your email — Law of the Land",
          html: `
            <p>Welcome to Law of the Land.</p>
            <p>Confirm your email address to start asking legal questions and saving your chats:</p>
            <p><a href="${url}">Verify my email</a></p>
            <p>If you did not create this account, you can ignore this message.</p>
          `,
        });
      },
    },
    socialProviders: {
      ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: process.env.GITHUB_CLIENT_ID,
              clientSecret: process.env.GITHUB_CLIENT_SECRET,
            },
          }
        : {}),
      ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {}),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, hookCtx) => {
            if (!hookCtx || !isOAuthCallbackRoute(hookCtx.path)) {
              return;
            }

            const user = await authComponent.getAnyUserById(
              ctx,
              session.userId,
            );
            if (user && parseAdminRoles(user.role).length > 0) {
              throw new APIError("FORBIDDEN", {
                code: "ADMIN_OAUTH_REQUIRES_CREDENTIAL_2FA",
                message:
                  "Administrators must use Two Factor credential sign-in",
              });
            }
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (hookCtx) => {
        if (isGuardedAdminPluginRoute(hookCtx.path)) {
          throw new APIError("FORBIDDEN", {
            code: "GUARDED_ADMIN_MUTATION_REQUIRED",
            message: "Guarded admin mutation required",
          });
        }
      }),
    },
    plugins: [
      admin({
        ac: adminAccessControl,
        roles: betterAuthAdminRoles,
        defaultRole: "user",
        adminRoles: [...ADMIN_ROLES],
        impersonationSessionDuration: 900,
      }),
      twoFactor({ issuer: "Law of the Land Admin" }),
      convex({ authConfig }),
    ],
  }) satisfies BetterAuthOptions;

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth(createAuthOptions(ctx));

export const { getAuthUser } = authComponent.clientApi();
