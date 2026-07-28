"use client";

import { api } from "../../../convex/_generated/api";
import { useMutation } from "convex/react";
import { useState } from "react";
import { StepUpDialog } from "./step-up-dialog";

export function AdminRecoveryControl({
  environment,
  enabled: initialEnabled,
}: {
  environment: string;
  enabled: boolean;
}) {
  const setAdminPanel = useMutation(api.admin.featureFlags.setAdminPanel);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [desired, setDesired] = useState<boolean | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [feedback, setFeedback] = useState("");

  function begin(nextEnabled: boolean) {
    setFeedback("");
    setIdempotencyKey(crypto.randomUUID());
    setDesired(nextEnabled);
  }

  const confirmation = desired === null
    ? ""
    : `ADMIN_PANEL ${environment} ${desired ? "ENABLE" : "DISABLE"}`;

  async function apply(input: { reason: string; confirmation?: string }) {
    if (desired === null || !idempotencyKey) return;
    const result = await setAdminPanel({
      environment,
      enabled: desired,
      confirmation: input.confirmation ?? "",
      reason: input.reason,
      idempotencyKey,
    });
    setEnabled(desired);
    setFeedback(
      `Persisted flag ${desired ? "enabled" : "disabled"}. Correlation ${result.correlationId}.`,
    );
  }

  return (
    <section aria-labelledby="recovery-state-heading" className="mt-12 border-y border-[oklch(58%_0.04_252)] py-8">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,0.72fr)_minmax(18rem,1.28fr)] lg:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(45%_0.07_65)]">
            Persisted control
          </p>
          <h2 id="recovery-state-heading" className="mt-3 text-3xl font-semibold tracking-[-0.04em]">
            {enabled ? "Enabled" : "Disabled"}
          </h2>
          <p className="mt-3 max-w-[48ch] text-sm leading-6 text-[oklch(40%_0.035_252)]">
            Environment <strong>{environment}</strong>. The deployment gate remains independent and must be changed through the deployment owner workflow.
          </p>
        </div>
        <div className="flex flex-col gap-3 lg:items-end">
          <button
            type="button"
            onClick={() => begin(!enabled)}
            className="min-h-11 border border-[oklch(31%_0.055_252)] bg-[oklch(28%_0.055_252)] px-5 py-3 text-sm font-semibold text-[oklch(97%_0.012_82)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
          >
            {enabled ? "Disable persisted flag" : "Enable persisted flag"}
          </button>
          {feedback ? <p role="status" className="max-w-[52ch] text-sm leading-6">{feedback}</p> : null}
        </div>
      </div>

      <StepUpDialog
        open={desired !== null}
        title={`${desired ? "Enable" : "Disable"} persisted admin access?`}
        description="This audited recovery action changes only the selected environment row. It does not alter the deployment gate or any administrator role."
        submitLabel={`Verify and ${desired ? "enable" : "disable"}`}
        cancelLabel="Cancel recovery action"
        targetId={`admin_panel:${environment}`}
        idempotencyKey={idempotencyKey}
        stepUpAction="admin_panel_set"
        confirmationPhrase={confirmation}
        onClose={() => setDesired(null)}
        onConfirmed={apply}
      />
    </section>
  );
}
