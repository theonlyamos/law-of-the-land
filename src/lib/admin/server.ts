import { api } from "../../../convex/_generated/api";
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

export async function authorizeAdminPage(
  fetchQuery: AdminQueryFetcher = defaultFetcher,
): Promise<CurrentAdmin> {
  return (await fetchQuery(
    api.admin.overview.currentAdmin,
    {},
  )) as CurrentAdmin;
}

export async function loadAdminOverview(
  fetchQuery: AdminQueryFetcher = defaultFetcher,
): Promise<{ currentAdmin: CurrentAdmin; overview: AdminOverview | null }> {
  const currentAdmin = await authorizeAdminPage(fetchQuery);
  if (!hasRolePermission(currentAdmin.roles, "operations", "read")) {
    return { currentAdmin, overview: null };
  }
  const overview = (await fetchQuery(
    api.admin.overview.get,
    {},
  )) as AdminOverview;
  return { currentAdmin, overview };
}
