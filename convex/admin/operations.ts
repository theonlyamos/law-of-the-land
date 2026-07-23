import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireEnabledAdminPermission } from "./featureFlags";

const MAX_PAGE_SIZE = 20;
const CURSOR_PREFIX = "integration-health:v1:";

const integrationHealthRowValidator = v.object({
  id: v.string(),
  label: v.string(),
  configured: v.boolean(),
  status: v.union(v.literal("ready"), v.literal("configuration_required")),
});

const INTEGRATIONS = [
  {
    id: "identity",
    label: "Identity and sessions",
    environmentVariables: ["SITE_URL", "BETTER_AUTH_SECRET"],
  },
  {
    id: "legal-search",
    label: "Legal search",
    environmentVariables: ["GROUNDX_API_KEY"],
  },
  {
    id: "answer-generation",
    label: "Answer generation",
    environmentVariables: ["GOOGLE_AI_API_KEY"],
  },
  {
    id: "billing",
    label: "Billing",
    environmentVariables: ["POLAR_ORGANIZATION_TOKEN"],
  },
  {
    id: "email",
    label: "Transactional email",
    environmentVariables: ["RESEND_API_KEY"],
  },
] as const;

function readOffset(cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new Error("INVALID_ADMIN_CURSOR");
  }
  const value = Number(cursor.slice(CURSOR_PREFIX.length));
  if (!Number.isSafeInteger(value) || value < 0 || value > INTEGRATIONS.length) {
    throw new Error("INVALID_ADMIN_CURSOR");
  }
  return value;
}

export const listIntegrationHealth = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(integrationHealthRowValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireEnabledAdminPermission(ctx, "operations", "read");
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1
    ) {
      throw new Error("INVALID_ADMIN_PAGINATION");
    }

    const offset = readOffset(args.paginationOpts.cursor);
    const pageSize = Math.min(args.paginationOpts.numItems, MAX_PAGE_SIZE);
    const end = Math.min(offset + pageSize, INTEGRATIONS.length);
    const page = INTEGRATIONS.slice(offset, end).map((integration) => {
      const configured = integration.environmentVariables.every(
        (name) => {
          const value = process.env[name];
          return typeof value === "string" && value.trim().length > 0;
        },
      );
      return {
        id: integration.id,
        label: integration.label,
        configured,
        status: configured
          ? "ready" as const
          : "configuration_required" as const,
      };
    });

    return {
      page,
      isDone: end >= INTEGRATIONS.length,
      continueCursor: `${CURSOR_PREFIX}${end}`,
    };
  },
});
