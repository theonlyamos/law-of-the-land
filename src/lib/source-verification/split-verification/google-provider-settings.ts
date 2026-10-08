/** Fixed Google protocol bounds shared by the app and the offline experiment.
 * Campaign scheduling and POST limits remain in the experiment catalog. */
export const GOOGLE_PROVIDER_SETTINGS = Object.freeze({
  endpoint: "https://generativelanguage.googleapis.com/v1beta/interactions", model: "gemini-3.8-flash",
  thinkingLevel: "medium", maxOutputTokens: 8192, maxWireBytes: 131072, maxRawResponseBytes: 2097152,
  maxModelJsonBytes: 65536, deadlineMs: 85000,
} as const);
