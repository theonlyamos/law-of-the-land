// The closed catalogue of facts profile memory may hold. Nothing outside these
// slots is ever stored, so the extractor cannot save free-form notes about a
// person, and sensitive topics (health, family, immigration, criminal matters,
// money) have no slot to land in.

export const PROFILE_FACT_CATALOG = {
  role: {
    label: "Role",
    multiple: true,
    values: {
      tenant: "Tenant",
      landlord: "Landlord",
      employee: "Employee",
      employer: "Employer",
      business_owner: "Business owner",
      consumer: "Consumer",
      property_owner: "Property owner",
      lawyer: "Lawyer",
      paralegal: "Paralegal",
      law_student: "Law student",
      compliance_officer: "Compliance officer",
    },
  },
  expertise: {
    label: "Legal background",
    multiple: false,
    values: {
      general_public: "No legal background",
      legal_professional: "Legal professional",
    },
  },
  sector: {
    label: "Sector",
    multiple: true,
    values: {
      agriculture: "Agriculture",
      construction: "Construction",
      education: "Education",
      energy: "Energy",
      finance: "Finance and banking",
      healthcare: "Healthcare",
      hospitality: "Hospitality",
      manufacturing: "Manufacturing",
      media: "Media",
      mining: "Mining",
      nonprofit: "Non-profit",
      professional_services: "Professional services",
      real_estate: "Real estate",
      retail: "Retail",
      technology: "Technology",
      telecommunications: "Telecommunications",
      transport: "Transport and logistics",
    },
  },
  topic: {
    label: "Recurring topic",
    multiple: true,
    values: {
      tenancy: "Tenancy",
      employment: "Employment",
      company_registration: "Company registration",
      land_and_property: "Land and property",
      contracts: "Contracts",
      consumer_rights: "Consumer rights",
      tax: "Tax",
      data_protection: "Data protection",
      intellectual_property: "Intellectual property",
      regulatory_compliance: "Regulatory compliance",
    },
  },
  answer_preference: {
    label: "Answer style",
    multiple: true,
    values: {
      brief: "Brief answers",
      detailed: "Detailed answers",
      cite_sections: "Include section numbers",
      plain_language: "Plain language",
    },
  },
} as const;

export type ProfileFactType = keyof typeof PROFILE_FACT_CATALOG;
export const PROFILE_FACT_TYPES = Object.keys(PROFILE_FACT_CATALOG) as ProfileFactType[];

/** Values that cannot both be true; a new stated value demotes the other. */
export const PROFILE_FACT_CONFLICTS: Readonly<Record<string, readonly string[]>> = {
  "answer_preference:brief": ["detailed"],
  "answer_preference:detailed": ["brief"],
};

export const PROFILE_MEMORY_LIMITS = {
  /** Confirmed facts kept per scope (personal or one organization). */
  maxConfirmed: 12,
  /** Candidates kept per scope; the oldest are dropped first. */
  maxCandidates: 40,
  /** Implied facts need this many sightings... */
  impliedSightings: 3,
  /** ...across this many separate chats... */
  impliedChats: 2,
  /** ...spread over at least this long. */
  impliedSpanMs: 24 * 60 * 60 * 1000,
  /** Implied facts not seen again for this long go back to being candidates. */
  impliedDecayMs: 90 * 24 * 60 * 60 * 1000,
  /** Candidates not seen again for this long are deleted. */
  candidateExpiryMs: 30 * 24 * 60 * 60 * 1000,
  /** Saved supporting quotes are cut to this length. */
  maxQuoteLength: 80,
  /** Questions shorter than this are not worth an extraction call. */
  minQuestionLength: 24,
  maxQuestionLength: 4_000,
  /** At most this many observations are accepted from one question. */
  maxObservationsPerQuestion: 4,
} as const;

export function isProfileFactType(value: unknown): value is ProfileFactType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROFILE_FACT_CATALOG, value);
}

export function isProfileFactValue(type: ProfileFactType, value: unknown): value is string {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROFILE_FACT_CATALOG[type].values, value);
}

export function profileFactLabel(type: ProfileFactType, value: string): string {
  const values = PROFILE_FACT_CATALOG[type].values as Record<string, string>;
  return values[value] ?? value;
}

export type ProfileFact = { type: ProfileFactType; value: string };

/** The compact shape sent to the answer model. Keys only, no quotes or dates. */
export type ChatUserProfile = Partial<Record<ProfileFactType, string[]>>;

export function toChatUserProfile(facts: readonly ProfileFact[]): ChatUserProfile | undefined {
  const profile: ChatUserProfile = {};
  for (const { type, value } of facts) {
    if (!isProfileFactType(type) || !isProfileFactValue(type, value)) continue;
    const list = profile[type] ?? [];
    if (!list.includes(value)) list.push(value);
    profile[type] = list;
  }
  return Object.keys(profile).length ? profile : undefined;
}

/** Validates a profile that crossed a trust boundary. Unknown keys or values are dropped. */
export function parseChatUserProfile(value: unknown): ChatUserProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const facts: ProfileFact[] = [];
  for (const [type, values] of Object.entries(value)) {
    if (!isProfileFactType(type) || !Array.isArray(values)) continue;
    for (const item of values.slice(0, PROFILE_MEMORY_LIMITS.maxConfirmed)) {
      if (isProfileFactValue(type, item)) facts.push({ type, value: item });
    }
  }
  return toChatUserProfile(facts.slice(0, PROFILE_MEMORY_LIMITS.maxConfirmed * 2));
}

function normalizeForQuote(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[‘’]/gu, "'").replace(/\s+/gu, " ").trim();
}

/** True when the quote appears word for word in the question (case and spacing aside). */
export function quoteAppearsIn(question: string, quote: string): boolean {
  const needle = normalizeForQuote(quote);
  return needle.length >= 3 && normalizeForQuote(question).includes(needle);
}

export function trimQuote(quote: string): string {
  const clean = quote.replace(/\s+/gu, " ").trim();
  return clean.length <= PROFILE_MEMORY_LIMITS.maxQuoteLength
    ? clean
    : `${clean.slice(0, PROFILE_MEMORY_LIMITS.maxQuoteLength - 1).trimEnd()}…`;
}
