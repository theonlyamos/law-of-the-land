import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { twoFactor } from "better-auth/plugins/two-factor";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";
import authSchema from "./betterAuth/schema";
import { sendEmail } from "./lib/email";

const siteUrl = process.env.SITE_URL!;

export const authComponent = createClient<DataModel, typeof authSchema>(
  components.betterAuth,
  { local: { schema: authSchema } },
);

export const createAuthOptions = (ctx: GenericCtx<DataModel>) =>
  ({
    baseURL: siteUrl,
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
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
    plugins: [twoFactor(), convex({ authConfig })],
  }) satisfies BetterAuthOptions;

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth(createAuthOptions(ctx));

export const { getAuthUser } = authComponent.clientApi();
