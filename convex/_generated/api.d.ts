/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin_audit from "../admin/audit.js";
import type * as admin_billing from "../admin/billing.js";
import type * as admin_conversations from "../admin/conversations.js";
import type * as admin_documents from "../admin/documents.js";
import type * as admin_exports from "../admin/exports.js";
import type * as admin_exportActions from "../admin/exportActions.js";
import type * as admin_featureFlags from "../admin/featureFlags.js";
import type * as admin_jobs from "../admin/jobs.js";
import type * as admin_migrations from "../admin/migrations.js";
import type * as admin_overview from "../admin/overview.js";
import type * as admin_publication from "../admin/publication.js";
import type * as admin_publicationState from "../admin/publicationState.js";
import type * as admin_reviews from "../admin/reviews.js";
import type * as admin_operations from "../admin/operations.js";
import type * as admin_resources from "../admin/resources.js";
import type * as admin_roles from "../admin/roles.js";
import type * as admin_users from "../admin/users.js";
import type * as auth from "../auth.js";
import type * as chats from "../chats.js";
import type * as jurisdictions from "../jurisdictions.js";
import type * as http from "../http.js";
import type * as lib_adminPermissions from "../lib/adminPermissions.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_email from "../lib/email.js";
import type * as lib_requireAdmin from "../lib/requireAdmin.js";
import type * as lib_requireUser from "../lib/requireUser.js";
import type * as polar from "../polar.js";
import type * as usage from "../usage.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "admin/audit": typeof admin_audit;
  "admin/billing": typeof admin_billing;
  "admin/conversations": typeof admin_conversations;
  "admin/documents": typeof admin_documents;
  "admin/exports": typeof admin_exports;
  "admin/exportActions": typeof admin_exportActions;
  "admin/featureFlags": typeof admin_featureFlags;
  "admin/jobs": typeof admin_jobs;
  "admin/migrations": typeof admin_migrations;
  "admin/overview": typeof admin_overview;
  "admin/publication": typeof admin_publication;
  "admin/publicationState": typeof admin_publicationState;
  "admin/reviews": typeof admin_reviews;
  "admin/operations": typeof admin_operations;
  "admin/resources": typeof admin_resources;
  "admin/roles": typeof admin_roles;
  "admin/users": typeof admin_users;
  auth: typeof auth;
  chats: typeof chats;
  jurisdictions: typeof jurisdictions;
  http: typeof http;
  "lib/adminPermissions": typeof lib_adminPermissions;
  "lib/audit": typeof lib_audit;
  "lib/email": typeof lib_email;
  "lib/requireAdmin": typeof lib_requireAdmin;
  "lib/requireUser": typeof lib_requireUser;
  polar: typeof polar;
  usage: typeof usage;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
  polar: import("@convex-dev/polar/_generated/component.js").ComponentApi<"polar">;
};
