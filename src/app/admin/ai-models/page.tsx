import { api } from "../../../../convex/_generated/api";
import { hasRolePermission } from "../../../../convex/lib/adminPermissions";
import { AiModelForm } from "@/components/admin/ai-model-form";
import { authorizeAdminPage } from "@/lib/admin/server";
import { fetchAuthQuery } from "@/lib/auth-server";
import { redirect } from "next/navigation";
import { AI_MODEL_FEATURE_INFO, resolveAiModel, type AiModelFeature } from "../../../../shared/ai-models";

type Setting = {
  feature: AiModelFeature;
  model: string | null;
  convexEffectiveModel: string;
  updatedAt: number | null;
  updatedBy: string | null;
};

function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(timestamp));
}

/** Where the model in use comes from when no admin setting exists. */
function fallbackSource(feature: AiModelFeature): string {
  const info = AI_MODEL_FEATURE_INFO[feature];
  const host = info.runtime === "next" ? "Vercel" : "Convex";
  return info.envVars.length
    ? `${info.envVars.join(", then ")} on ${host}, then the built-in default`
    : "the built-in default";
}

export default async function AiModelsPage() {
  const access = await authorizeAdminPage();
  if (access.status === "denied" || !hasRolePermission(access.currentAdmin.roles, "operations", "read")) redirect("/admin/forbidden");
  const canWrite = hasRolePermission(access.currentAdmin.roles, "operations", "write");

  let settings: Setting[] = [];
  let failed = false;
  try {
    settings = (await fetchAuthQuery(api.admin.aiModels.list, {})) as Setting[];
  } catch {
    failed = true;
  }

  return (
    <div className="mx-auto max-w-[88rem]">
      <header className="border-b-2 border-slate-700 pb-7">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-800">Control · configuration</p>
        <h1 className="mt-3 text-5xl font-semibold tracking-[-0.05em]">AI models</h1>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-700">
          The model each feature calls. A model set here replaces the environment variable for that feature. Clear it to go back to the
          environment variable or built-in default. Every change is recorded in the audit log.
        </p>
      </header>
      {failed ? (
        <p role="alert" className="mt-8 border-l-4 border-amber-700 bg-amber-50 px-4 py-3 text-sm">
          AI model settings could not be loaded. Refresh to try again.
        </p>
      ) : (
        <ul aria-label="AI model settings" className="mt-8 grid gap-0 border-t border-slate-300">
          {settings.map((setting) => {
            const info = AI_MODEL_FEATURE_INFO[setting.feature];
            // Next.js features fall back to this server's environment; Convex features to Convex's.
            const inUse = info.runtime === "next"
              ? resolveAiModel(setting.feature, setting.model ? { [setting.feature]: setting.model } : null, process.env)
              : setting.convexEffectiveModel;
            return (
              <li key={setting.feature} className="grid gap-5 border-b border-slate-300 py-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
                <div>
                  <h2 className="text-xl font-semibold">{info.label}</h2>
                  <p className="mt-1 text-sm leading-6 text-slate-700">{info.description}</p>
                  <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
                    <dt className="text-slate-600">In use now</dt>
                    <dd><code className="font-mono text-[0.85rem]">{inUse}</code>{setting.model ? " (set here)" : null}</dd>
                    <dt className="text-slate-600">Provider</dt>
                    <dd>{info.provider}</dd>
                    <dt className="text-slate-600">Without a setting</dt>
                    <dd>Uses {fallbackSource(setting.feature)} (<code className="font-mono text-[0.85rem]">{info.defaultModel}</code>)</dd>
                    <dt className="text-slate-600">Takes effect</dt>
                    <dd>{info.appliesTo}</dd>
                    {setting.updatedAt ? (
                      <>
                        <dt className="text-slate-600">Last changed</dt>
                        <dd>{formatDateTime(setting.updatedAt)} UTC</dd>
                      </>
                    ) : null}
                  </dl>
                </div>
                <AiModelForm feature={setting.feature} label={info.label} model={setting.model} placeholder={info.defaultModel} canWrite={canWrite} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
