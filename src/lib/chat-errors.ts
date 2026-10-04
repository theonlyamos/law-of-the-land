// Only closed, actionable application reasons may cross the public chat boundary.
export type ChatErrorReason = "file_search_budget_exhausted";

export function publicChatErrorReason(value: unknown): ChatErrorReason | null {
  return value === "file_search_budget_exhausted" ? value : null;
}

export const CHAT_SEARCH_LIMIT_MESSAGE = "We reached the search limit for this answer before it could be verified. Each answer has its own search limit. You can ask a narrower question about one issue, or start a new chat.";
