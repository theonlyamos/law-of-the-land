import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import {
  makeFunctionReference,
  type FunctionReference,
} from "convex/server";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
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

const twoFactorVerificationRoutes = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-otp",
  "/two-factor/verify-backup-code",
]);

const stepUpActions = new Set([
  "roles_assign",
  "impersonation_start",
  "user_deletion_queue",
  "conversation_export",
  "admin_panel_set",
]);
const stepUpKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const recordAdminStepUpProofReference =
  makeFunctionReference<"mutation">(
    "admin/users:recordAdminStepUpProof",
  );
const consumePreparedImpersonationReference =
  makeFunctionReference<"mutation">(
    "admin/users:consumePreparedImpersonation",
  );
const finalizePreparedImpersonationReference =
  makeFunctionReference<"mutation">(
    "admin/users:finalizePreparedImpersonation",
  );

type AdminImpersonationRequestContext = {
  actorId: string;
  targetId: string;
  idempotencyKey: string;
};

async function runAuthMutation<T>(
  ctx: GenericCtx<DataModel>,
  reference: FunctionReference<"mutation">,
  args: Record<string, unknown>,
): Promise<T> {
  if (!("runMutation" in ctx) || typeof ctx.runMutation !== "function") {
    throw new APIError("INTERNAL_SERVER_ERROR", {
      code: "ADMIN_AUTH_CONTEXT_INVALID",
      message: "Administrative authentication context is unavailable",
    });
  }
  return await (
    ctx as unknown as {
      runMutation: (
        mutation: FunctionReference<"mutation">,
        mutationArgs: Record<string, unknown>,
      ) => Promise<T>;
    }
  ).runMutation(reference, args);
}

function requestHeader(
  hookCtx: {
    headers?: Headers | null;
    request?: Request;
  },
  name: string,
): string | null {
  return hookCtx.headers?.get(name) ?? hookCtx.request?.headers.get(name) ?? null;
}

function readStepUpScope(hookCtx: {
  headers?: Headers | null;
  request?: Request;
}) {
  const action = requestHeader(hookCtx, "x-admin-step-up-action");
  const targetId = requestHeader(hookCtx, "x-admin-step-up-target");
  const idempotencyKey = requestHeader(hookCtx, "x-admin-step-up-key");
  if (
    !action ||
    !stepUpActions.has(action) ||
    !targetId ||
    targetId.length > 256 ||
    !idempotencyKey ||
    !stepUpKeyPattern.test(idempotencyKey)
  ) {
    return null;
  }
  return { action, targetId, idempotencyKey };
}

function endpointSucceeded(returned: unknown): boolean {
  if (!returned || isAPIError(returned)) {
    return false;
  }
  if (returned instanceof Response) {
    return returned.ok;
  }
  return typeof returned === "object";
}

export function isTwoFactorVerificationRoute(path: string): boolean {
  return twoFactorVerificationRoutes.has(path);
}

export const createAuthOptions = (
  ctx: GenericCtx<DataModel>,
  internalOptions: {
    allowGuardedAdminRoutes?: boolean;
    onVerificationDelivery?: (succeeded: boolean) => void;
  } = {},
) =>
  ({
    baseURL: siteUrl,
    database: authComponent.adapter(ctx),
    session: {
      additionalFields: {
        adminTwoFactorVerifiedAt: {
          type: "date",
          required: false,
          input: false,
        },
      },
    },
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
        try {
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
          internalOptions.onVerificationDelivery?.(true);
        } catch (error) {
          internalOptions.onVerificationDelivery?.(false);
          throw error;
        }
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
            if (hookCtx && isTwoFactorVerificationRoute(hookCtx.path)) {
              return {
                data: { adminTwoFactorVerifiedAt: new Date() },
              };
            }
            if (!hookCtx || !isOAuthCallbackRoute(hookCtx.path)) {
              return;
            }

            const user = await hookCtx.context.internalAdapter.findUserById(
              session.userId,
            );
            const authoritativeRole = (user as { role?: unknown } | null)
              ?.role;
            if (parseAdminRoles(authoritativeRole).length > 0) {
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
        if (
          isGuardedAdminPluginRoute(hookCtx.path) &&
          internalOptions.allowGuardedAdminRoutes !== true
        ) {
          if (hookCtx.path === "/admin/impersonate-user") {
            const session = await getSessionFromCtx(hookCtx);
            const targetId =
              typeof hookCtx.body === "object" &&
              hookCtx.body !== null &&
              "userId" in hookCtx.body &&
              typeof hookCtx.body.userId === "string"
                ? hookCtx.body.userId
                : null;
            const idempotencyKey = requestHeader(
              hookCtx,
              "x-admin-operation-key",
            );
            if (
              session &&
              targetId &&
              idempotencyKey &&
              stepUpKeyPattern.test(idempotencyKey)
            ) {
              const allowed = await runAuthMutation<boolean>(
                ctx,
                consumePreparedImpersonationReference,
                {
                  actorId: session.user.id,
                  sessionId: session.session.id,
                  targetId,
                  idempotencyKey,
                },
              );
              if (allowed) {
                (
                  hookCtx.context as typeof hookCtx.context & {
                    adminImpersonationRequest?: AdminImpersonationRequestContext;
                  }
                ).adminImpersonationRequest = {
                  actorId: session.user.id,
                  targetId,
                  idempotencyKey,
                };
                return;
              }
            }
          }
          throw new APIError("FORBIDDEN", {
            code: "GUARDED_ADMIN_MUTATION_REQUIRED",
            message: "Guarded admin mutation required",
          });
        }
        if (hookCtx.path === "/two-factor/disable") {
          const session = await getSessionFromCtx(hookCtx);
          if (session && parseAdminRoles(session.user.role).length > 0) {
            throw new APIError("FORBIDDEN", {
              code: "ADMIN_TWO_FACTOR_REQUIRED",
              message: "Administrators cannot disable Two Factor",
            });
          }
        }
      }),
      after: createAuthMiddleware(async (hookCtx) => {
        if (
          hookCtx.path === "/verify-password" &&
          endpointSucceeded(hookCtx.context.returned)
        ) {
          const scope = readStepUpScope(hookCtx);
          const session = await getSessionFromCtx(hookCtx);
          if (scope && session) {
            await runAuthMutation(ctx, recordAdminStepUpProofReference, {
              actorId: session.user.id,
              sessionId: session.session.id,
              ...scope,
            });
          }
        }
        if (hookCtx.path === "/admin/impersonate-user") {
          const request = (
            hookCtx.context as typeof hookCtx.context & {
              adminImpersonationRequest?: AdminImpersonationRequestContext;
            }
          ).adminImpersonationRequest;
          if (request) {
            await runAuthMutation(
              ctx,
              finalizePreparedImpersonationReference,
              {
                ...request,
                succeeded: endpointSucceeded(hookCtx.context.returned),
              },
            );
          }
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

/**
 * Server-only constructor for application mutations that have already passed
 * the Convex feature, permission, assurance, and audit gates. Browser traffic
 * continues through createAuth and cannot opt into this route allowance.
 */
export const createGuardedAdminAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth(createAuthOptions(ctx, { allowGuardedAdminRoutes: true }));

export const createVerificationDeliveryAuth = (
  ctx: GenericCtx<DataModel>,
  onVerificationDelivery: (succeeded: boolean) => void,
) => betterAuth(createAuthOptions(ctx, { onVerificationDelivery }));

export const { getAuthUser } = authComponent.clientApi();
