import "server-only";

export type PlaceSuggestion = {
  placeId: string;
  primaryText: string;
  secondaryText: string;
  types: string[];
};

export type VerifiedPlace = {
  placeId: string;
  displayName: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
  types: string[];
  countryCode?: string;
  addressComponents: Array<{
    longText: string;
    shortText: string;
    types: string[];
  }>;
};

export type PlacesProvider = {
  autocomplete(input: string, sessionToken: string): Promise<PlaceSuggestion[]>;
  details(placeId: string, sessionToken: string): Promise<VerifiedPlace>;
};

type Environment = Record<string, string | undefined>;
type PlacesDependencies = {
  autocomplete?(input: string, sessionToken: string): Promise<PlaceSuggestion[]>;
  details?(placeId: string, sessionToken: string): Promise<VerifiedPlace>;
};

const ISOLATION_KEYS = [
  "ADMIN_E2E_FIXTURE_MODE",
  "ADMIN_E2E_TARGET_ENV",
  "ADMIN_E2E_ISOLATED_TARGET_MARKER",
  "ADMIN_E2E_PROVIDER_STUB_MODE",
  "ADMIN_E2E_CONVEX_URL",
  "ADMIN_E2E_CONVEX_SITE_URL",
  "ADMIN_E2E_APPROVED_COMMIT_SHA",
  "ADMIN_E2E_LOCAL_HEAD_SHA",
] as const;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const STUB_PLACE_PREFIX = "e2e-jurisdiction-place-";
const STUB_PLACE_NAME = "Accra";

function invalidIsolation(): never {
  throw new Error("E2E_PROVIDER_ISOLATION_MISCONFIGURED");
}

function exact(environment: Environment, key: string): string {
  const value = environment[key];
  if (typeof value !== "string" || !value || value !== value.trim()) invalidIsolation();
  return value;
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "::1"
    || hostname === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function isProductionLooking(value: string): boolean {
  return /(?:^|[.:-])(?:prod|production|live)(?:[.:-]|$)/i.test(value);
}

function parseEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidIsolation();
  }
  if (!/^https?:$/.test(url.protocol)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || isProductionLooking(url.hostname)) {
    invalidIsolation();
  }
  return url;
}

function remoteDeployment(url: URL, suffix: string): { name: string; region: string } | null {
  if (!url.hostname.endsWith(suffix)) return null;
  const labels = url.hostname.slice(0, -suffix.length).split(".");
  if (labels.length !== 2) return null;
  const [name, region] = labels;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(region)
    ? { name, region }
    : null;
}

function isIsolated(environment: Environment): boolean {
  if (ISOLATION_KEYS.every((key) => environment[key] === undefined)) return false;
  if (exact(environment, "ADMIN_E2E_FIXTURE_MODE") !== "true"
    || !["test", "preview"].includes(exact(environment, "ADMIN_E2E_TARGET_ENV"))
    || exact(environment, "ADMIN_E2E_ISOLATED_TARGET_MARKER") !== "isolated-admin-e2e"
    || exact(environment, "ADMIN_E2E_PROVIDER_STUB_MODE") !== "true"
    || isProductionLooking(environment.CONVEX_DEPLOYMENT ?? "")) {
    invalidIsolation();
  }
  const backend = parseEndpoint(exact(environment, "ADMIN_E2E_CONVEX_URL"));
  const site = parseEndpoint(exact(environment, "ADMIN_E2E_CONVEX_SITE_URL"));
  const localBackend = isLocalhost(backend.hostname);
  if (localBackend !== isLocalhost(site.hostname)
    || (localBackend && backend.hostname !== site.hostname)) {
    invalidIsolation();
  }
  if (!localBackend) {
    const backendDeployment = remoteDeployment(backend, ".convex.cloud");
    const siteDeployment = remoteDeployment(site, ".convex.site");
    const binding = /^dev:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/.exec(
      exact(environment, "CONVEX_DEPLOYMENT"),
    );
    if (backend.protocol !== "https:"
      || site.protocol !== "https:"
      || backend.port
      || site.port
      || !backendDeployment
      || !siteDeployment
      || backendDeployment.name !== siteDeployment.name
      || backendDeployment.region !== siteDeployment.region
      || binding?.[1] !== backendDeployment.name) {
      invalidIsolation();
    }
  }
  const approved = exact(environment, "ADMIN_E2E_APPROVED_COMMIT_SHA");
  const local = exact(environment, "ADMIN_E2E_LOCAL_HEAD_SHA");
  if (!SHA_PATTERN.test(approved) || approved !== local) invalidIsolation();
  return true;
}

function stubPlaceId(sessionToken: string): string {
  return `${STUB_PLACE_PREFIX}${sessionToken}`;
}

function stubPlace(sessionToken: string): VerifiedPlace {
  return {
    placeId: stubPlaceId(sessionToken),
    displayName: STUB_PLACE_NAME,
    formattedAddress: `${STUB_PLACE_NAME}, Ghana`,
    latitude: 5.6037,
    longitude: -0.187,
    types: ["locality", "political"],
    countryCode: "GH",
    addressComponents: [
      { longText: "Ghana", shortText: "GH", types: ["country", "political"] },
      {
        longText: "Greater Accra Region",
        shortText: "Greater Accra",
        types: ["administrative_area_level_1", "political"],
      },
    ],
  };
}

export function createPlacesProvider(
  environment: Environment,
  dependencies: PlacesDependencies = {},
): PlacesProvider {
  if (isIsolated(environment)) {
    return {
      async autocomplete(_input, sessionToken) {
        if (!UUID_V4_PATTERN.test(sessionToken)) throw new Error("GOOGLE_PLACES_INVALID_REQUEST");
        return [{
          placeId: stubPlaceId(sessionToken),
          primaryText: STUB_PLACE_NAME,
          secondaryText: "Ghana",
          types: ["locality", "political"],
        }];
      },
      async details(placeId, sessionToken) {
        if (!UUID_V4_PATTERN.test(sessionToken) || placeId !== stubPlaceId(sessionToken)) {
          throw new Error("GOOGLE_PLACES_INVALID_REQUEST");
        }
        return stubPlace(sessionToken);
      },
    };
  }

  return {
    async autocomplete(input, sessionToken) {
      if (!dependencies.autocomplete) throw new Error("GOOGLE_PLACES_NOT_CONFIGURED");
      return await dependencies.autocomplete(input, sessionToken);
    },
    async details(placeId, sessionToken) {
      if (!dependencies.details) throw new Error("GOOGLE_PLACES_NOT_CONFIGURED");
      return await dependencies.details(placeId, sessionToken);
    },
  };
}
