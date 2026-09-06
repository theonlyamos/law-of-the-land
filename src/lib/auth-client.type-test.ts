import type { AuthClient } from "@convex-dev/better-auth/react";
import type { createAuthClient } from "better-auth/react";
import type { authClient } from "./auth-client";

type Assert<T extends true> = T;
type AppClient = typeof authClient;
type PlainClient = ReturnType<typeof createAuthClient>;
type ProviderSession = ReturnType<AuthClient["useSession"]>["data"];

// Checked by tsc, without executing authentication or weakening the boundary.
export type AcceptsConfiguredClient = Assert<AppClient extends AuthClient ? true : false>;
export type RejectsMissingConvexPlugin = Assert<PlainClient extends AuthClient ? false : true>;
export type RequiresSessionHook = Assert<Omit<AppClient, "useSession"> extends AuthClient ? false : true>;
export type RequiresSessionFetch = Assert<Omit<AppClient, "getSession"> extends AuthClient ? false : true>;
export type SessionIsNotNever = Assert<[ProviderSession] extends [never] ? false : true>;
export type AllowsSignedOutSession = Assert<null extends ProviderSession ? true : false>;
