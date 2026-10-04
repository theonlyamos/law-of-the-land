// Only closed, actionable application reasons may cross the public chat boundary.
export type ChatErrorReason = "file_search_budget_exhausted" | "deadline_exceeded";

export function publicChatErrorReason(value: unknown): ChatErrorReason | null {
  return value === "file_search_budget_exhausted" || value === "deadline_exceeded" ? value : null;
}

export const CHAT_SEARCH_LIMIT_MESSAGE = "We reached the search limit for this answer before it could be verified. Each answer has its own search limit. You can ask a narrower question about one issue, or start a new chat.";
export const CHAT_TIMEOUT_MESSAGE = "This answer took too long and could not be verified. You can ask a more focused question or try again later.";

export function publicChatErrorMessage(reason: ChatErrorReason): string {
  switch (reason) {
    case "file_search_budget_exhausted": return CHAT_SEARCH_LIMIT_MESSAGE;
    case "deadline_exceeded": return CHAT_TIMEOUT_MESSAGE;
  }
}
