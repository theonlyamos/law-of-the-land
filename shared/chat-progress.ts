/** Request header a client sends when it understands `status` stream events.
 * Clients without it (for example a tab opened before a deploy) never receive them. */
export const CHAT_PROGRESS_HEADER = "x-chat-progress";

export type ChatProgressStage = "searching" | "writing" | "checking";

/** Content-free progress for an answer that is still being researched.
 * It never carries model text, so unverified answers stay on the server. */
export type ChatProgress = { stage: ChatProgressStage; searches: number };

const MAX_REPORTED_SEARCHES = 99;

export function parseChatProgress(value: Record<string, unknown>): ChatProgress | null {
  const { stage, searches } = value;
  if (stage !== "searching" && stage !== "writing" && stage !== "checking") return null;
  if (typeof searches !== "number" || !Number.isSafeInteger(searches) || searches < 0) return null;
  return { stage, searches: Math.min(searches, MAX_REPORTED_SEARCHES) };
}

export function chatProgressLabel(progress: ChatProgress | undefined): string {
  if (!progress) return "Reading your question…";
  if (progress.stage === "writing") return "Writing the answer…";
  if (progress.stage === "checking") return "Checking the answer against its sources…";
  if (progress.searches === 0) return "Searching the law library…";
  return `Searching the law library (${progress.searches} ${progress.searches === 1 ? "search" : "searches"} so far)…`;
}
