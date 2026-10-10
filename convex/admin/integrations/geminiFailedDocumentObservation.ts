import { GoogleGenAI, UploadToFileSearchStoreOperation } from "@google/genai";
import { isGeminiFileSearchStoreName, isGeminiUploadOperationForStore, parseGeminiDocumentName } from "../../lib/geminiFileSearchNames";
import type { DiagnosticTarget, GeminiDiagnosticClient } from "./geminiDiagnostic";

const PAGE_SIZE = 20;
const MAX_PAGES = 20;
const METADATA_KEYS = ["environment", "jurisdiction_id", "resource_id", "version_id", "version_number", "sha256"] as const;
const DOCUMENT_STATES = new Set(["STATE_UNSPECIFIED", "STATE_PENDING", "STATE_ACTIVE", "STATE_FAILED"]);

export type FailedDocumentObservation = { documentReference: string; operationReference: string; observedAt: number };

function invalidProof(): never { throw new Error("GEMINI_DOCUMENT_OBSERVATION_INVALID"); }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validateTarget(target: DiagnosticTarget): void {
  if (!target || !isGeminiFileSearchStoreName(target.storeName) || !isGeminiUploadOperationForStore(target.operationName, target.storeName)) invalidProof();
  const metadata = record(target.metadata);
  if (!metadata || Object.keys(metadata).length !== METADATA_KEYS.length ||
      !METADATA_KEYS.every(key => typeof metadata[key] === "string") ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(target.metadata.environment) ||
      ![target.metadata.jurisdiction_id, target.metadata.resource_id, target.metadata.version_id].every(value => /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value)) ||
      !/^[1-9]\d{0,10}$/.test(target.metadata.version_number) || !/^[a-f0-9]{64}$/.test(target.metadata.sha256)) invalidProof();
}

function defaultClient(apiKey: string): GeminiDiagnosticClient {
  const sdk = new GoogleGenAI({ apiKey, httpOptions: { timeout: 10_000, retryOptions: { attempts: 1 } } });
  return {
    operations: { get: async request => await sdk.operations.get(request) },
    fileSearchStores: { documents: {
      list: async request => await sdk.fileSearchStores.documents.list(request),
      get: async request => await sdk.fileSearchStores.documents.get(request),
    } },
  };
}

async function requireOperation(client: GeminiDiagnosticClient, target: DiagnosticTarget, completedDocumentName?: string): Promise<void> {
  const operation = new UploadToFileSearchStoreOperation();
  operation.name = target.operationName;
  const raw = record(await client.operations.get({ operation }));
  if (!raw || raw.name !== target.operationName || raw.error !== undefined) invalidProof();
  if (completedDocumentName === undefined) {
    // Google omits default false; present null, strings, or a response are contradictions.
    if ((raw.done !== undefined && raw.done !== false) || raw.response !== undefined) invalidProof();
  } else {
    const response = record(raw.response);
    if (raw.done !== true || response?.documentName !== completedDocumentName) invalidProof();
  }
}

function metadataMatches(value: unknown, expected: DiagnosticTarget["metadata"]): boolean {
  if (value === undefined) return false;
  if (!Array.isArray(value) || value.length > 20) invalidProof();
  const entries = new Map<string, Record<string, unknown>>();
  for (const item of value) {
    const entry = record(item);
    if (!entry || typeof entry.key !== "string" || entry.key.length < 1 || entry.key.length > 64 || entries.has(entry.key)) invalidProof();
    if (!Object.keys(entry).every(key => ["key", "stringValue", "numericValue", "stringListValue"].includes(key))) invalidProof();
    if ([entry.stringValue, entry.numericValue, entry.stringListValue].filter(candidate => candidate !== undefined).length !== 1) invalidProof();
    if (entry.stringValue !== undefined && (typeof entry.stringValue !== "string" || entry.stringValue.length > 1_024)) invalidProof();
    if (entry.numericValue !== undefined && (typeof entry.numericValue !== "number" || !Number.isFinite(entry.numericValue))) invalidProof();
    if (entry.stringListValue !== undefined) {
      const strings = record(entry.stringListValue);
      if (!strings || Object.keys(strings).some(key => key !== "values") || !Array.isArray(strings.values) ||
          !strings.values.every(string => typeof string === "string" && string.length <= 1_024)) invalidProof();
    }
    entries.set(entry.key, entry);
  }
  return METADATA_KEYS.every(key => entries.get(key)?.stringValue === expected[key]);
}

function readDocument(value: unknown, storeName: string): Record<string, unknown> & { name: string } {
  const document = record(value);
  const parsed = typeof document?.name === "string" ? parseGeminiDocumentName(document.name) : null;
  if (!document || !parsed || parsed.storeName !== storeName ||
      (document.state !== undefined && (typeof document.state !== "string" || !DOCUMENT_STATES.has(document.state)))) invalidProof();
  return document as Record<string, unknown> & { name: string };
}

async function uniqueDocument(target: DiagnosticTarget, client: GeminiDiagnosticClient, expectedState: "STATE_FAILED" | "STATE_ACTIVE"): Promise<string> {
  const pager = await client.fileSearchStores.documents.list({ parent: target.storeName, config: { pageSize: PAGE_SIZE } });
  const seenNames = new Set<string>();
  let matchName: string | null = null;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = pageNumber === 0 ? pager.page : await pager.nextPage();
    if (!Array.isArray(page) || page.length > PAGE_SIZE) invalidProof();
    for (const raw of page) {
      const document = readDocument(raw, target.storeName);
      // Repeated rows invalidate scan completeness, even if they repeat one name.
      if (seenNames.has(document.name)) invalidProof();
      seenNames.add(document.name);
      if (metadataMatches(document.customMetadata, target.metadata)) {
        if (matchName !== null || document.state !== expectedState) invalidProof();
        matchName = document.name;
      }
    }
    const more = pager.hasNextPage();
    if (typeof more !== "boolean") invalidProof();
    if (!more) {
      if (matchName === null) invalidProof();
      const document = readDocument(await client.fileSearchStores.documents.get({ name: matchName }), target.storeName);
      if (document.name !== matchName || document.state !== expectedState || !metadataMatches(document.customMetadata, target.metadata)) invalidProof();
      return matchName;
    }
  }
  // A partial scan cannot prove uniqueness.
  return invalidProof();
}

async function reference(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Read-only, fail-closed candidate evidence. A separate durable poll must confirm it. */
export async function observeFailedGeminiDocument(target: DiagnosticTarget, apiKey: string, injectedClient?: GeminiDiagnosticClient): Promise<FailedDocumentObservation | null> {
  try {
    validateTarget(target);
    if (!apiKey.trim()) invalidProof();
    const client = injectedClient ?? defaultClient(apiKey);
    await requireOperation(client, target);
    const documentName = await uniqueDocument(target, client, "STATE_FAILED");
    await requireOperation(client, target);
    return { documentReference: await reference(documentName), operationReference: await reference(target.operationName), observedAt: Date.now() };
  } catch {
    // Neither an incomplete listing nor a provider request error proves document failure.
    return null;
  }
}

/** A completed upload operation alone is insufficient publication proof. */
export async function verifyCompletedGeminiDocument(target: DiagnosticTarget, documentName: string, apiKey: string, injectedClient?: GeminiDiagnosticClient): Promise<void> {
  try {
    validateTarget(target);
    if (!apiKey.trim()) invalidProof();
    const parsed = parseGeminiDocumentName(documentName);
    if (parsed?.storeName !== target.storeName) invalidProof();
    const client = injectedClient ?? defaultClient(apiKey);
    await requireOperation(client, target, documentName);
    if (await uniqueDocument(target, client, "STATE_ACTIVE") !== documentName) invalidProof();
    await requireOperation(client, target, documentName);
  } catch {
    // Never attach raw provider responses, headers, resource names, or credentials as cause.
    throw new Error("GEMINI_COMPLETED_DOCUMENT_PROOF_FAILED");
  }
}
