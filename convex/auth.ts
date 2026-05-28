import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth, type AuthProviderConfig } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { z } from "zod";

const emailSchema = z.string().email();

const passwordProvider = Password({
  profile(params) {
    const email = emailSchema.parse(params.email);
    const name = typeof params.name === "string" ? params.name.trim() : undefined;
    return { email, ...(name ? { name } : {}) };
  },
  validatePasswordRequirements(password: string) {
    if (
      password.length < 8 ||
      !/\d/.test(password) ||
      !/[a-z]/.test(password) ||
      !/[A-Z]/.test(password)
    ) {
      throw new ConvexError(
        "Password must be at least 8 characters and include uppercase, lowercase, and a number."
      );
    }
  },
});

const providers: AuthProviderConfig[] = [passwordProvider];

if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  providers.push(
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    })
  );
}

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    })
  );
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers,
});
