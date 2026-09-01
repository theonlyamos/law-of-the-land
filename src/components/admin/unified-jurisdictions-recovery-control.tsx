"use client";

import type { UnifiedJurisdictionRolloutState } from "../../../convex/lib/unifiedJurisdictionRollout";
import { api } from "../../../convex/_generated/api";
import { useMutation } from "convex/react";
import { useState } from "react";
import { StepUpDialog } from "./step-up-dialog";

function blockerLabel(blocker: string) {
  const label = blocker.toLowerCase().replaceAll("_", " ");
  return label.replace(/^./, (letter) => letter.toUpperCase());
}

export function UnifiedJurisdictionsRecoveryControl({
  rollout,
}: {
  rollout: UnifiedJurisdictionRolloutState;
}) {
  const setUnifiedJurisdictions = useMutation(
    api.admin.featureFlags.setUnifiedJurisdictions,
  );
  const [enabled, setEnabled] = useState(rollout.flagEnabled);
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
    : `UNIFIED_JURISDICTIONS ${rollout.environment} ${desired ? "ENABLE" : "DISABLE"}`;
  const verifiedTargets = rollout.targets.filter(
    (target) => target.status === "verified",
  ).length;

  async function apply(input: { reason: string; confirmation?: string }) {
    if (desired === null || !idempotencyKey) return;
    const result = await setUnifiedJurisdictions({
      environment: rollout.environment,
      enabled: desired,
      confirmation: input.confirmation ?? "",
      reason: input.reason,
      idempotencyKey,
    });
    setEnabled(desired);
    setFeedback(
      `Unified jurisdictions ${desired ? "enabled" : "disabled"}. Correlation ${result.correlationId}.`,
    );
  }

  return (
    <section
      aria-labelledby="unified-jurisdictions-recovery-heading"
      className="mt-12 border-y border-[oklch(58%_0.04_252)] py-8"
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,0.72fr)_minmax(18rem,1.28fr)] lg:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[oklch(45%_0.07_65)]">
            Research rollout
          </p>
          <h2
            id="unified-jurisdictions-recovery-heading"
            className="mt-3 text-3xl font-semibold tracking-[-0.04em]"
          >
            {enabled
              ? "Enabled"
              : rollout.canEnable
                ? "Ready to enable"
                : "Blocked"}
          </h2>
          <p className="mt-3 max-w-[52ch] text-sm leading-6 text-[oklch(40%_0.035_252)]">
            Environment <strong>{rollout.environment}</strong>. Ghana is {rollout.ghana.ready ? "ready" : "not ready"}; {verifiedTargets} of {rollout.targets.length} migration targets are verified.
          </p>
          {!enabled && rollout.blockers.length > 0 ? (
            <ul className="mt-3 grid gap-1 text-sm text-[oklch(38%_0.08_28)]">
              {rollout.blockers.map((blocker) => (
                <li key={blocker}>{blockerLabel(blocker)}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex flex-col gap-3 lg:items-end">
          <button
            type="button"
            disabled={!enabled && !rollout.canEnable}
            onClick={() => begin(!enabled)}
            className="min-h-11 border border-[oklch(31%_0.055_252)] bg-[oklch(28%_0.055_252)] px-5 py-3 text-sm font-semibold text-[oklch(97%_0.012_82)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {enabled
              ? "Disable unified jurisdictions"
              : "Enable unified jurisdictions"}
          </button>
          {feedback ? (
            <p role="status" className="max-w-[52ch] text-sm leading-6">
              {feedback}
            </p>
          ) : null}
        </div>
      </div>

      <StepUpDialog
        open={desired !== null}
        title={`${desired ? "Enable" : "Disable"} unified jurisdictions?`}
        description="This audited recovery action changes only the unified-jurisdictions flag for the selected environment. Enablement is rejected unless every migration readiness gate remains clean."
        submitLabel={`Verify and ${desired ? "enable" : "disable"}`}
        cancelLabel="Cancel rollout action"
        targetId={`unified_jurisdictions:${rollout.environment}`}
        idempotencyKey={idempotencyKey}
        stepUpAction="unified_jurisdictions_set"
        confirmationPhrase={confirmation}
        onClose={() => setDesired(null)}
        onConfirmed={apply}
      />
    </section>
  );
}
