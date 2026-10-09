import { isLocalReviewedEmploymentRequest } from "./reviewed-employment-chat";
import { productionReviewedEmploymentEnabled, reviewedEmploymentNextPolicy, PRODUCTION_REVIEWED_EMPLOYMENT_POLICY } from "../../../shared/reviewed-employment-policy";

type Environment = Readonly<Record<string, string | undefined>>;
export const REVIEWED_EMPLOYMENT_BACKGROUND_ADMISSION_MS = 25_000;

/** Admission and a full 270-second job share the 300-second Next host window.
 * Keep five seconds for closing failures, using the original request clocks. */
export function createReviewedEmploymentBackgroundAdmission(startedAt: number, startedMonotonic: number) {
  const controller = new AbortController();
  const deadlineError = new Error("CHAT_BACKGROUND_ADMISSION_DEADLINE_EXPIRED");
  const remaining = () => REVIEWED_EMPLOYMENT_BACKGROUND_ADMISSION_MS
    - Math.max(0, Date.now() - startedAt, performance.now() - startedMonotonic);
  const available = remaining();
  const timer = Number.isFinite(available) && available > 0
    ? setTimeout(() => controller.abort(deadlineError), available) : undefined;
  if (timer === undefined) controller.abort(deadlineError);
  const assertWithinDeadline = () => {
    const left = remaining();
    if (!Number.isFinite(left) || left <= 0) controller.abort(deadlineError);
    if (controller.signal.aborted) throw deadlineError;
  };
  return {
    assertWithinDeadline,
    async run<T>(operation: () => Promise<T>): Promise<T> {
      assertWithinDeadline();
      const pending = operation();
      return new Promise<T>((resolve, reject) => {
        const detach = () => controller.signal.removeEventListener("abort", onAbort);
        const onAbort = () => { detach(); reject(deadlineError); };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        // Consume both outcomes even when the native RPC ignores our timeout.
        // A late accepted submit is recovered through the queued-only GET path.
        void pending.then(value => {
          detach();
          try { assertWithinDeadline(); resolve(value); } catch (error) { reject(error); }
        }, error => { detach(); reject(error); });
        if (controller.signal.aborted) onAbort();
      });
    },
    dispose() { clearTimeout(timer); },
  };
}

function isProductionPolicy(env: Environment): boolean {
  return reviewedEmploymentNextPolicy(env) === PRODUCTION_REVIEWED_EMPLOYMENT_POLICY;
}

/** Execution may drain accepted work after admission is disabled. */
export function isReviewedEmploymentBackgroundExecutionEnabled(env: Environment): boolean {
  if (isProductionPolicy(env)) return env.REVIEWED_EMPLOYMENT_PRODUCTION_EXECUTION_ENABLED === "1";
  return reviewedEmploymentNextPolicy(env) !== null
    && env.LOCAL_REVIEWED_EMPLOYMENT_BACKGROUND_ENABLED === "1"
    && env.LOCAL_REVIEWED_EMPLOYMENT_SPLIT_ENABLED === "1"
    && env.LOCAL_REVIEWED_EMPLOYMENT_CALLS_APPROVED === "1";
}

function sameOriginRequest(request: Request, env: Environment): boolean {
  try {
    const url = new URL(request.url);
    if (url.username || url.password) return false;
    const headers = new Headers(request.headers);
    const site = headers.get("sec-fetch-site");
    if (site && !["same-origin", "none"].includes(site)) return false;
    if (request.method === "GET" && !headers.has("origin")) headers.set("origin", url.origin);
    if (isProductionPolicy(env)) return url.origin === "https://lawoftheland.vercel.app"
      && headers.get("origin") === url.origin;
    return isLocalReviewedEmploymentRequest(new Request(request.url, { method: "POST", headers }), env);
  } catch { return false; }
}

/** Owner reads and cancellation survive admission and execution rollback.
 * Native same-origin GETs need not send Origin; cancellation POSTs must. */
export function isReviewedEmploymentBackgroundReadRequest(request: Request, env: Environment): boolean {
  return (request.method === "GET" || request.method === "POST")
    && reviewedEmploymentNextPolicy(env) !== null && sameOriginRequest(request, env);
}

/** New saved jobs require admission and execution; never use this for cancel. */
export function isReviewedEmploymentBackgroundRequest(request: Request, env: Environment): boolean {
  return (request.method === "POST" || request.method === "GET")
    && isReviewedEmploymentBackgroundExecutionEnabled(env)
    && (!isProductionPolicy(env) || productionReviewedEmploymentEnabled(env))
    && sameOriginRequest(request, env);
}

// Retain the local pilot API for existing callers while production uses the same
// closed deployment and origin checks. Lifecycle routes use the read gate above.
export const isLocalReviewedEmploymentBackgroundRequest = isReviewedEmploymentBackgroundRequest;
