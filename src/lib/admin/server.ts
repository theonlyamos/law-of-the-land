import { api } from "../../../convex/_generated/api";
import {
  isAdminAccessCode,
  type AdminAccessCode,
} from "../../../convex/lib/adminAccessErrors";
import { hasRolePermission } from "../../../convex/lib/adminPermissions";
import type { FunctionReturnType } from "convex/server";
import { fetchAuthQuery } from "../auth-server";

export type CurrentAdmin = FunctionReturnType<
  typeof api.admin.overview.currentAdmin
>;
export type AdminOverview = FunctionReturnType<typeof api.admin.overview.get>;

type AdminQuery =
  | typeof api.admin.overview.currentAdmin
  | typeof api.admin.overview.get;
type AdminQueryResult = CurrentAdmin | AdminOverview;

export type AdminQueryFetcher = (
  query: AdminQuery,
  args: Record<string, never>,
) => Promise<AdminQueryResult>;

const defaultFetcher = fetchAuthQuery as AdminQueryFetcher;

export type AdminPageAccess =
  | { status: "authorized"; currentAdmin: CurrentAdmin }
  | { status: "denied" };

function adminAccessCodeFromError(error: unknown): AdminAccessCode | null {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return null;
  }

  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null || !("code" in data)) {
    return null;
  }

  const code = (data as { code?: unknown }).code;
  return isAdminAccessCode(code) ? code : null;
}

export async function authorizeAdminPage(
  fetchQuery: AdminQueryFetcher = defaultFetcher,
): Promise<AdminPageAccess> {
  try {
    const currentAdmin = (await fetchQuery(
      api.admin.overview.currentAdmin,
      {},
    )) as CurrentAdmin;
    return { status: "authorized", currentAdmin };
  } catch (error) {
    if (adminAccessCodeFromError(error)) {
      return { status: "denied" };
    }
    throw error;
  }
}

export async function loadAdminOverview(
  fetchQuery: AdminQueryFetcher = defaultFetcher,
): Promise<{ access: AdminPageAccess; overview: AdminOverview | null }> {
  const access = await authorizeAdminPage(fetchQuery);
  if (access.status === "denied") {
    return { access, overview: null };
  }
  const { currentAdmin } = access;
  if (!hasRolePermission(currentAdmin.roles, "operations", "read")) {
    return { access, overview: null };
  }
  const overview = (await fetchQuery(
    api.admin.overview.get,
    {},
  )) as AdminOverview;
  return { access, overview };
}
