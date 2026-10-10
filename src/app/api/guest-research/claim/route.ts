import { getToken } from "@/lib/auth-server";
import { PUBLICATION_FILTER_PROTOCOL } from "../../../../../shared/gemini-publication-filter";
import { assertResearchRequest, callGuestBridge, guestError, guestFailure, guestJson, guestSessionHash } from "@/lib/guest-research-server";

export async function POST(request: Request) {
  try {
    assertResearchRequest(request);
    const authToken = await getToken();
    if (!authToken) throw new Error("AUTH_REQUIRED");
    const tokenHash = await guestSessionHash(request);
    if (!tokenHash) throw new Error("SESSION_INVALID");
    const result = await callGuestBridge("adopt", { tokenHash, publicationFilterProtocol: PUBLICATION_FILTER_PROTOCOL }, { authToken });
    return "error" in result ? guestError(result.error) : guestJson(result);
  } catch (caught) { return guestFailure(caught); }
}
