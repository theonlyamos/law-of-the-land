/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin_analytics from "../admin/analytics.js";
import type * as admin_audit from "../admin/audit.js";
import type * as admin_billing from "../admin/billing.js";
import type * as admin_conversations from "../admin/conversations.js";
import type * as admin_documents from "../admin/documents.js";
import type * as admin_e2eAccessMatrix from "../admin/e2eAccessMatrix.js";
import type * as admin_e2eFixtures from "../admin/e2eFixtures.js";
import type * as admin_e2eProviderIsolation from "../admin/e2eProviderIsolation.js";
import type * as admin_exportActions from "../admin/exportActions.js";
import type * as admin_exports from "../admin/exports.js";
import type * as admin_featureFlags from "../admin/featureFlags.js";
import type * as admin_geminiActions from "../admin/geminiActions.js";
import type * as admin_integrations_geminiFileSearch from "../admin/integrations/geminiFileSearch.js";
import type * as admin_jobs from "../admin/jobs.js";
import type * as admin_jurisdictions from "../admin/jurisdictions.js";
import type * as admin_migrations from "../admin/migrations.js";
import type * as admin_operations from "../admin/operations.js";
import type * as admin_organizations from "../admin/organizations.js";
import type * as admin_overview from "../admin/overview.js";
import type * as admin_publication from "../admin/publication.js";
import type * as admin_publicationState from "../admin/publicationState.js";
import type * as admin_resources from "../admin/resources.js";
import type * as admin_reviews from "../admin/reviews.js";
import type * as admin_roles from "../admin/roles.js";
import type * as admin_users from "../admin/users.js";
import type * as auth from "../auth.js";
import type * as chats from "../chats.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as jurisdictions from "../jurisdictions.js";
import type * as lib_adminAccessErrors from "../lib/adminAccessErrors.js";
import type * as lib_adminPermissions from "../lib/adminPermissions.js";
import type * as lib_adminStepUp from "../lib/adminStepUp.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_chatCitationClaim from "../lib/chatCitationClaim.js";
import type * as lib_email from "../lib/email.js";
import type * as lib_geminiFileSearchNames from "../lib/geminiFileSearchNames.js";
import type * as lib_jurisdictionAccess from "../lib/jurisdictionAccess.js";
import type * as lib_jurisdictionDomain from "../lib/jurisdictionDomain.js";
import type * as lib_jurisdictionEligibility from "../lib/jurisdictionEligibility.js";
import type * as lib_legacyJurisdictionCompatibility from "../lib/legacyJurisdictionCompatibility.js";
import type * as lib_placeClaim from "../lib/placeClaim.js";
import type * as lib_requireAdmin from "../lib/requireAdmin.js";
import type * as lib_requireUser from "../lib/requireUser.js";
import type * as lib_researchManifestProof from "../lib/researchManifestProof.js";
import type * as lib_researchScope from "../lib/researchScope.js";
import type * as lib_telemetryProof from "../lib/telemetryProof.js";
import type * as lib_unifiedJurisdictionRollout from "../lib/unifiedJurisdictionRollout.js";
import type * as polar from "../polar.js";
import type * as telemetry from "../telemetry.js";
import type * as usage from "../usage.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "admin/analytics": typeof admin_analytics;
  "admin/audit": typeof admin_audit;
  "admin/billing": typeof admin_billing;
  "admin/conversations": typeof admin_conversations;
  "admin/documents": typeof admin_documents;
  "admin/e2eAccessMatrix": typeof admin_e2eAccessMatrix;
  "admin/e2eFixtures": typeof admin_e2eFixtures;
  "admin/e2eProviderIsolation": typeof admin_e2eProviderIsolation;
  "admin/exportActions": typeof admin_exportActions;
  "admin/exports": typeof admin_exports;
  "admin/featureFlags": typeof admin_featureFlags;
  "admin/geminiActions": typeof admin_geminiActions;
  "admin/integrations/geminiFileSearch": typeof admin_integrations_geminiFileSearch;
  "admin/jobs": typeof admin_jobs;
  "admin/jurisdictions": typeof admin_jurisdictions;
  "admin/migrations": typeof admin_migrations;
  "admin/operations": typeof admin_operations;
  "admin/organizations": typeof admin_organizations;
  "admin/overview": typeof admin_overview;
  "admin/publication": typeof admin_publication;
  "admin/publicationState": typeof admin_publicationState;
  "admin/resources": typeof admin_resources;
  "admin/reviews": typeof admin_reviews;
  "admin/roles": typeof admin_roles;
  "admin/users": typeof admin_users;
  auth: typeof auth;
  chats: typeof chats;
  crons: typeof crons;
  http: typeof http;
  jurisdictions: typeof jurisdictions;
  "lib/adminAccessErrors": typeof lib_adminAccessErrors;
  "lib/adminPermissions": typeof lib_adminPermissions;
  "lib/adminStepUp": typeof lib_adminStepUp;
  "lib/audit": typeof lib_audit;
  "lib/chatCitationClaim": typeof lib_chatCitationClaim;
  "lib/email": typeof lib_email;
  "lib/geminiFileSearchNames": typeof lib_geminiFileSearchNames;
  "lib/jurisdictionAccess": typeof lib_jurisdictionAccess;
  "lib/jurisdictionDomain": typeof lib_jurisdictionDomain;
  "lib/jurisdictionEligibility": typeof lib_jurisdictionEligibility;
  "lib/legacyJurisdictionCompatibility": typeof lib_legacyJurisdictionCompatibility;
  "lib/placeClaim": typeof lib_placeClaim;
  "lib/requireAdmin": typeof lib_requireAdmin;
  "lib/requireUser": typeof lib_requireUser;
  "lib/researchManifestProof": typeof lib_researchManifestProof;
  "lib/researchScope": typeof lib_researchScope;
  "lib/telemetryProof": typeof lib_telemetryProof;
  "lib/unifiedJurisdictionRollout": typeof lib_unifiedJurisdictionRollout;
  polar: typeof polar;
  telemetry: typeof telemetry;
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
