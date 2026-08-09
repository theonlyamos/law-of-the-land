import {
  issueVerifiedPlaceClaim,
  VERIFIED_PLACE_CLAIM_TTL_MS,
} from "../../../../../../convex/lib/placeClaim";
import { getVerifiedPlace } from "@/lib/google-places";
import {
  authorizePlacesRequest,
  isUuidV4,
  json,
  readBoundedObject,
} from "../request";

const MAX_CLAIM_ALIASES = 19;

export async function POST(request: Request) {
  const body = await readBoundedObject(request);
  const placeId = typeof body?.placeId === "string" ? body.placeId : "";
  const sessionToken = body?.sessionToken;
  if (
    placeId.length < 1 ||
    placeId.length > 255 ||
    placeId.trim() !== placeId ||
    !isUuidV4(sessionToken)
  ) {
    return json({ error: "Select a valid place and try again." }, 400);
  }

  const authorization = await authorizePlacesRequest();
  if (authorization.response) return authorization.response;

  try {
    const place = await getVerifiedPlace(placeId, sessionToken);
    const issuedAt = Date.now();
    const aliases = place.addressComponents
      .flatMap((component) => [component.longText, component.shortText])
      .slice(0, MAX_CLAIM_ALIASES);
    const verifiedPlaceClaim = await issueVerifiedPlaceClaim(
      authorization.actorId,
      {
        googlePlaceId: place.placeId,
        name: place.displayName,
        formattedAddress: place.formattedAddress,
        latitude: place.latitude,
        longitude: place.longitude,
        ...(place.countryCode === undefined ? {} : { countryCode: place.countryCode }),
        aliases,
      },
      issuedAt,
    );
    return json({
      place,
      verifiedPlaceClaim,
      expiresAt: issuedAt + VERIFIED_PLACE_CLAIM_TTL_MS,
    }, 200);
  } catch {
    return json({ error: "Place details are temporarily unavailable." }, 503);
  }
}
