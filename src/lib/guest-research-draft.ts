const DRAFT_TTL_MS = 24 * 60 * 60 * 1_000;

function draftKey(chatId?: string) {
  return chatId ? `guest-research-draft:${chatId}` : "guest-research-draft";
}

export function clearGuestResearchDraft(chatId?: string): void {
  try {
    localStorage.removeItem(draftKey(chatId));
  } catch {
    // Storage may be disabled; research remains usable without draft persistence.
  }
}

export function saveGuestResearchDraft(draft: string, chatId?: string): void {
  if (!draft) return clearGuestResearchDraft(chatId);
  try {
    localStorage.setItem(draftKey(chatId), JSON.stringify({
      draft: draft.slice(0, 4_000), expiresAt: Date.now() + DRAFT_TTL_MS,
    }));
  } catch {
    // Keep the current composer usable when browser storage is unavailable.
  }
}

export function readGuestResearchDraft(chatId?: string): string {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(draftKey(chatId)) ?? "null");
    if (stored && typeof stored === "object"
      && "draft" in stored && typeof stored.draft === "string" && stored.draft.length <= 4_000
      && "expiresAt" in stored && typeof stored.expiresAt === "number"
      && stored.expiresAt > Date.now() && stored.expiresAt <= Date.now() + DRAFT_TTL_MS) {
      return stored.draft;
    }
  } catch {
    // Malformed or unavailable storage must not block research.
  }
  clearGuestResearchDraft(chatId);
  return "";
}
