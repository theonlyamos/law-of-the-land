"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import {
  REVIEWED_EMPLOYMENT_JOB_ERRORS, REVIEWED_EMPLOYMENT_JOB_PROGRESS, REVIEWED_EMPLOYMENT_JOB_STATUSES,
  type ReviewedEmploymentJobProjection,
} from "../../../shared/reviewed-employment-jobs";

export type BackgroundSubmissionRecovery = { userClientId: string; assistantClientId: string;
  requiresCapability: boolean; startedAt: number; startedMonotonic: number };
type RecoveryOutcome = "ordinary_error" | "expired" | null;
type Observation = { key: string | null; job: ReviewedEmploymentJobProjection | null; enabled: boolean | null;
  awaitedAssistantClientId: string | null; checking: boolean; uncertain: boolean; cancelling: boolean; cancelError: string | null;
  recoveryKey: string | null; recoveryOutcome: RecoveryOutcome };
const empty: Observation = { key: null, job: null, enabled: null, awaitedAssistantClientId: null,
  checking: false, uncertain: false, cancelling: false, cancelError: null, recoveryKey: null, recoveryOutcome: null };
const unknownRecoveryLimitMs = 300000;
const noSavedMessages: readonly string[] = [];
type CancelIntent = { key: string; started: boolean };

function projection(value: unknown, externalId: string): ReviewedEmploymentJobProjection | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid job status");
  const job = value as Record<string, unknown>;
  for (const field of ["jobId", "externalId", "userClientId", "assistantClientId", "question"] as const) {
    if (typeof job[field] !== "string" || !job[field]) throw new Error("Invalid job status");
  }
  if (job.externalId !== externalId || !REVIEWED_EMPLOYMENT_JOB_STATUSES.some(value => value === job.status)
    || !REVIEWED_EMPLOYMENT_JOB_PROGRESS.some(value => value === job.progress)
    || (job.errorReason !== null && !REVIEWED_EMPLOYMENT_JOB_ERRORS.some(value => value === job.errorReason))) throw new Error("Invalid job status");
  for (const field of ["createdAt", "verificationDeadlineAt", "terminalDeadlineAt"] as const) {
    if (typeof job[field] !== "number" || !Number.isFinite(job[field])) throw new Error("Invalid job status");
  }
  // Keep only the public contract, even if a malformed server response contains private fields.
  return { jobId: job.jobId, externalId: job.externalId, userClientId: job.userClientId,
    assistantClientId: job.assistantClientId, question: job.question, status: job.status, progress: job.progress,
    createdAt: job.createdAt, verificationDeadlineAt: job.verificationDeadlineAt,
    terminalDeadlineAt: job.terminalDeadlineAt, errorReason: job.errorReason } as ReviewedEmploymentJobProjection;
}

/** Bound status transport and its body together, including fetch implementations
 * that ignore AbortSignal. Every lookup remains a single owner-authenticated read. */
async function readChatBackgroundStatus(externalId: string, jobId: string | null, signal: AbortSignal): Promise<{
  enabled: boolean; job: ReviewedEmploymentJobProjection | null;
}> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  let finishOnAbort = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cutoff = new Promise<never>((_resolve, reject) => {
    finishOnAbort = () => reject(new Error("Status unavailable"));
    controller.signal.addEventListener("abort", finishOnAbort, { once: true });
    timer = setTimeout(abort, 3000);
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([cutoff, (async () => {
      const exactJob = jobId ? `&job=${encodeURIComponent(jobId)}` : "";
      const response = await fetch(`/api/chat/background?chat=${encodeURIComponent(externalId)}${exactJob}`, {
        method: "GET", cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) throw new Error("Status unavailable");
      const data = await response.json() as Record<string, unknown>;
      if (typeof data.enabled !== "boolean") throw new Error("Invalid capability");
      const job = projection(data.job, externalId);
      controller.signal.throwIfAborted();
      return { enabled: data.enabled, job };
    })()]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", finishOnAbort);
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}

/** A transport failure is not evidence that this turn entered the job path. */
export async function findAcceptedChatBackgroundJob(input: {
  externalId: string; userClientId: string; assistantClientId: string; signal: AbortSignal;
}): Promise<ReviewedEmploymentJobProjection | null> {
  try {
    const { enabled, job } = await readChatBackgroundStatus(input.externalId, null, input.signal);
    if (!enabled || !job || job.userClientId !== input.userClientId || job.assistantClientId !== input.assistantClientId
      || !["queued", "running", "succeeded"].includes(job.status)) return null;
    return job;
  } catch {
    return null;
  }
}

export function useChatBackgroundJob({ chatId, isAuthenticated, pendingJobId, recoverySubmission = null,
  savedAssistantClientIds = noSavedMessages }: {
  chatId: string | null; isAuthenticated: boolean; pendingJobId: string | null;
  recoverySubmission?: BackgroundSubmissionRecovery | null; savedAssistantClientIds?: readonly string[];
}) {
  const session = authClient.useSession();
  const owner = !session.isPending && !session.error ? session.data?.user.id : null;
  const key = isAuthenticated && owner && chatId ? `${owner}|${chatId}` : null;
  const activeKey = useRef(key);
  activeKey.current = key;
  const savedIds = useRef(new Set(savedAssistantClientIds));
  savedIds.current = new Set(savedAssistantClientIds);
  const cancelIntent = useRef<CancelIntent | null>(null);
  if (cancelIntent.current?.key !== key) cancelIntent.current = null;
  const [state, setState] = useState<Observation>(empty);
  const [refresh, setRefresh] = useState(0);
  const current = state.key === key ? state : { ...empty, key, checking: Boolean(key) };
  const recoveryUserId = recoverySubmission?.userClientId ?? null;
  const recoveryAssistantId = recoverySubmission?.assistantClientId ?? null;
  const requiresCapability = recoverySubmission?.requiresCapability ?? false;
  const recoveryStartedAt = recoverySubmission?.startedAt ?? null;
  const recoveryStartedMonotonic = recoverySubmission?.startedMonotonic ?? null;
  const recoveryKey = recoverySubmission
    ? `${key}|${recoveryUserId}|${recoveryAssistantId}|${recoveryStartedAt}|${recoveryStartedMonotonic}` : null;
  const knownRecoveryCapability = useRef<string | null>(null);
  if (knownRecoveryCapability.current !== recoveryKey) knownRecoveryCapability.current = null;

  const performCancel = useCallback(async (jobId: string, intent: CancelIntent) => {
    if (intent.started || cancelIntent.current !== intent || activeKey.current !== intent.key) return;
    intent.started = true;
    try {
      const response = await fetch("/api/chat/background/cancel", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId }) });
      if (!response.ok) throw new Error("Cancellation unavailable");
      if (cancelIntent.current === intent && activeKey.current === intent.key) setRefresh(value => value + 1);
    } catch {
      if (cancelIntent.current === intent && activeKey.current === intent.key) setState(previous => ({ ...previous,
        cancelError: "We could not confirm that verification stopped. It may still be running." }));
    } finally {
      if (cancelIntent.current === intent && activeKey.current === intent.key) {
        cancelIntent.current = null;
        setState(previous => ({ ...previous, cancelling: false }));
      }
    }
  }, []);

  useEffect(() => {
    if (!key || !chatId) return;
    let detached = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let nativeRecoveryConfirmed = false;
    let observedJob = current.job;
    const controller = new AbortController();
    setState(previous => ({ ...empty, key, recoveryKey,
      enabled: previous.key === key ? previous.enabled : null,
      awaitedAssistantClientId: previous.key === key && previous.awaitedAssistantClientId
        && !savedIds.current.has(previous.awaitedAssistantClientId) ? previous.awaitedAssistantClientId : null,
      job: previous.key === key && (!pendingJobId || previous.job?.jobId === pendingJobId)
        && (!recoveryAssistantId || (previous.job?.assistantClientId === recoveryAssistantId && previous.job?.userClientId === recoveryUserId))
        ? previous.job : null,
      checking: previous.key !== key || previous.enabled === null,
      cancelling: cancelIntent.current?.key === key }));
    const finishRecovery = (recoveryOutcome: Exclude<RecoveryOutcome, null>) => {
      if (detached || nativeRecoveryConfirmed) return;
      detached = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (cancelIntent.current?.key === key) cancelIntent.current = null;
      setState(previous => ({ ...previous, key, job: null, awaitedAssistantClientId: null,
        checking: false, uncertain: false, cancelling: false, cancelError: null, recoveryKey, recoveryOutcome }));
    };
    const checkRecoveryDeadline = () => {
      if (detached || nativeRecoveryConfirmed || recoveryStartedAt === null || recoveryStartedMonotonic === null) return;
      // Wall-clock rollback cannot extend the unknown-submission window.
      const elapsed = Math.max(Date.now() - recoveryStartedAt, performance.now() - recoveryStartedMonotonic);
      const remaining = unknownRecoveryLimitMs - elapsed;
      if (remaining <= 0) finishRecovery("expired");
      else deadlineTimer = setTimeout(checkRecoveryDeadline, remaining);
    };
    const observe = async () => {
      if (detached) return;
      let pollAgain = false;
      try {
        const data = await readChatBackgroundStatus(chatId, pendingJobId, controller.signal);
        const job = data.job;
        if (detached) return;
        const missingAcceptedJob = Boolean(pendingJobId && (!job || job.jobId !== pendingJobId));
        const missingRecovery = Boolean(recoveryAssistantId && (!job || job.assistantClientId !== recoveryAssistantId || job.userClientId !== recoveryUserId));
        const uncertain = missingAcceptedJob || missingRecovery;
        if (!uncertain) observedJob = job;
        const confirmedSaved = Boolean(job && savedIds.current.has(job.assistantClientId));
        if (recoveryKey && data.enabled === true) knownRecoveryCapability.current = recoveryKey;
        if (recoveryAssistantId && !missingRecovery && job) {
          nativeRecoveryConfirmed = true;
          if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        } else if (recoveryAssistantId && requiresCapability && knownRecoveryCapability.current !== recoveryKey && data.enabled === false) {
          setState(previous => ({ ...previous, key, enabled: false }));
          finishRecovery("ordinary_error");
          return;
        }
        pollAgain = !confirmedSaved && (uncertain || job?.status === "queued" || job?.status === "running");
        if (!detached) {
          const terminal = job && job.status !== "queued" && job.status !== "running";
          if (!uncertain && (confirmedSaved || terminal) && cancelIntent.current?.key === key) cancelIntent.current = null;
          setState(previous => ({ ...previous, key, enabled: data.enabled as boolean, job: uncertain ? null : job,
            awaitedAssistantClientId: !uncertain && job && !confirmedSaved
              && (pendingJobId || recoveryAssistantId || job.status === "queued" || job.status === "running")
              ? job.assistantClientId : previous.awaitedAssistantClientId && !savedIds.current.has(previous.awaitedAssistantClientId)
                ? previous.awaitedAssistantClientId : null,
            checking: false, uncertain, recoveryOutcome: null,
            cancelling: cancelIntent.current?.key === key }));
          const intent = cancelIntent.current;
          if (!uncertain && !terminal && !confirmedSaved && job && intent?.key === key) void performCancel(job.jobId, intent);
        }
      } catch {
        if (detached) return;
        const knownPending = Boolean(pendingJobId || recoveryAssistantId
          || observedJob?.status === "queued" || observedJob?.status === "running");
        pollAgain = knownPending;
        setState(previous => ({ ...previous, key, checking: false, uncertain: knownPending }));
      }
      if (!detached && pollAgain) timer = setTimeout(() => { void observe(); }, 2000);
    };
    if (recoveryAssistantId) checkRecoveryDeadline();
    void observe();
    return () => {
      detached = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    };
  }, [key, chatId, pendingJobId, recoveryUserId, recoveryAssistantId, requiresCapability,
    recoveryStartedAt, recoveryStartedMonotonic, recoveryKey, refresh, performCancel]);

  const matchingJob = current.job && (!pendingJobId || current.job.jobId === pendingJobId)
    && (!recoveryAssistantId || (current.job.assistantClientId === recoveryAssistantId && current.job.userClientId === recoveryUserId))
    ? current.job : null;
  const jobId = matchingJob?.jobId ?? (!recoveryAssistantId ? pendingJobId : null);
  const cancel = useCallback(async () => {
    if (!key || current.cancelling || cancelIntent.current) return;
    const intent = { key, started: false };
    cancelIntent.current = intent;
    setState(previous => ({ ...previous, key, cancelling: true, cancelError: null }));
    if (jobId) await performCancel(jobId, intent);
  }, [key, jobId, current.cancelling, performCancel]);

  const confirmedSaved = Boolean((current.job && savedIds.current.has(current.job.assistantClientId))
    || (recoveryAssistantId && savedIds.current.has(recoveryAssistantId))
    || (current.awaitedAssistantClientId && savedIds.current.has(current.awaitedAssistantClientId)));
  useEffect(() => {
    if (!confirmedSaved || !key) return;
    if (cancelIntent.current?.key === key) cancelIntent.current = null;
    setState(previous => previous.key === key && previous.cancelling
      ? { ...previous, cancelling: false, cancelError: null } : previous);
  }, [confirmedSaved, key]);
  const recoveryOutcome = recoveryKey && current.recoveryKey === recoveryKey ? current.recoveryOutcome : null;
  return { ...current, recoveryOutcome, cancel, checking: !confirmedSaved && current.checking, uncertain: !confirmedSaved && current.uncertain,
    awaitedAssistantClientId: current.awaitedAssistantClientId && !savedIds.current.has(current.awaitedAssistantClientId)
      ? current.awaitedAssistantClientId : null,
    isPending: Boolean(key && !confirmedSaved && !recoveryOutcome && (current.uncertain
    || current.job?.status === "queued" || current.job?.status === "running"
    || (pendingJobId && (!current.job || current.job.jobId !== pendingJobId))
    || (recoveryAssistantId && (!current.job || current.job.assistantClientId !== recoveryAssistantId || current.job.userClientId !== recoveryUserId)))) };
}
