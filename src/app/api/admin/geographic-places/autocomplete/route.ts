import { autocompletePlaces } from "@/lib/google-places";
import {
  authorizePlacesRequest,
  isUuidV4,
  json,
  readBoundedObject,
} from "../request";

export async function POST(request: Request) {
  const body = await readBoundedObject(request);
  const input = typeof body?.input === "string" ? body.input.trim() : "";
  const sessionToken = body?.sessionToken;
  if (input.length < 3 || input.length > 200 || !isUuidV4(sessionToken)) {
    return json({ error: "Enter at least three characters to search for a place." }, 400);
  }

  const authorization = await authorizePlacesRequest();
  if (authorization.response) return authorization.response;

  try {
    const suggestions = await autocompletePlaces(input, sessionToken);
    return json({ suggestions }, 200);
  } catch {
    return json({ error: "Place search is temporarily unavailable." }, 503);
  }
}
