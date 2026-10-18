export const CHAT_POLICY_RESPONSES = {
  courtesy: "I'm here to help with legal questions. What would you like to ask?",
  unclear: "What legal question would you like help with? Please share the details that matter.",
  out_of_scope: "I can help with legal questions only. Please ask about a legal issue.",
  reviewed_coverage_gap: "The reviewed material available here does not cover this question well enough to give a verified answer.",
} as const;

export type ChatAnswerKind = "legal" | "policy" | "document";

export function isChatPolicyResponse(value: string): boolean {
  return Object.values(CHAT_POLICY_RESPONSES).some((response) => response === value);
}
