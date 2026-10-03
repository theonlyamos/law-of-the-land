import { GoogleGenAI, UploadToFileSearchStoreOperation } from "@google/genai";
import { isGeminiFileSearchStoreName, isGeminiUploadOperationForStore, parseGeminiDocumentName } from "../../lib/geminiFileSearchNames";
import type { DiagnosticTarget, GeminiDiagnosticClient } from "./geminiDiagnostic";

const PAGE_SIZE = 20;
const MAX_PAGES = 20;
const METADATA_KEYS = ["environment", "jurisdiction_id", "resource_id", "version_id", "version_number", "sha256"] as const;
const DOCUMENT_STATES = new Set(["STATE_UNSPECIFIED", "STATE_PENDING", "STATE_ACTIVE", "STATE_FAILED"]);

function failure(): Error {
  return new Error("GEMINI_ACTIVE_DOCUMENT_PROOF_FAILED");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validateTarget(target: DiagnosticTarget): void {
  if (!target || !isGeminiFileSearchStoreName(target.storeName) || !isGeminiUploadOperationForStore(target.operationName, target.storeName)) throw failure();
  const metadata = record(target.metadata);
  if (
    !metadata || Object.keys(metadata).length !== METADATA_KEYS.length ||
    !METADATA_KEYS.every((key) => typeof metadata[key] === "string") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(target.metadata.environment) ||
    ![target.metadata.jurisdiction_id, target.metadata.resource_id, target.metadata.version_id].every((value) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value)) ||
    !/^[1-9]\d{0,10}$/.test(target.metadata.version_number) ||
    !/^[a-f0-9]{64}$/.test(target.metadata.sha256)
  ) throw failure();
}

function defaultClient(apiKey: string): GeminiDiagnosticClient {
  const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 10_000, retryOptions: { attempts: 1 } } });
  return {
    operations: { get: async ({ operation }) => await client.operations.get({ operation }) },
    fileSearchStores: { documents: {
      list: async (request) => await client.fileSearchStores.documents.list(request),
      get: async (request) => await client.fileSearchStores.documents.get(request),
    } },
  };
}

async function requirePendingOperation(client: GeminiDiagnosticClient, operationName: string): Promise<void> {
  const operation = new UploadToFileSearchStoreOperation();
  operation.name = operationName;
  const result = record(await client.operations.get({ operation }));
  // Omitted done is the provider's default false. Present null/string values are invalid.
  if (!result || result.name !== operationName ||
      (result.done !== undefined && result.done !== false) ||
      result.error !== undefined || result.response !== undefined) throw failure();
}

function metadataMatches(value: unknown, expected: DiagnosticTarget["metadata"]): boolean {
  if (value === undefined) return false;
  if (!Array.isArray(value) || value.length > 20) throw failure();
  const entries = new Map<string, Record<string, unknown>>();
  for (const item of value) {
    const entry = record(item);
    if (!entry || typeof entry.key !== "string" || entry.key.length < 1 || entry.key.length > 64 || entries.has(entry.key)) throw failure();
    if (!Object.keys(entry).every((key) => ["key", "stringValue", "numericValue", "stringListValue"].includes(key))) throw failure();
    const valueCount = [entry.stringValue, entry.numericValue, entry.stringListValue].filter((candidate) => candidate !== undefined).length;
    if (valueCount !== 1) throw failure();
    if (entry.stringValue !== undefined && (typeof entry.stringValue !== "string" || entry.stringValue.length > 1_024)) throw failure();
    if (entry.numericValue !== undefined && (typeof entry.numericValue !== "number" || !Number.isFinite(entry.numericValue))) throw failure();
    if (entry.stringListValue !== undefined) {
      const strings = record(entry.stringListValue);
      if (!strings || Object.keys(strings).some((key) => key !== "values") || !Array.isArray(strings.values) ||
          !strings.values.every((string) => typeof string === "string" && string.length <= 1_024)) throw failure();
    }
    entries.set(entry.key, entry);
  }
  return METADATA_KEYS.every((key) => entries.get(key)?.stringValue === expected[key]);
}

function readDocument(value: unknown, storeName: string): Record<string, unknown> & { name: string } {
  const document = record(value);
  const parsed = typeof document?.name === "string" ? parseGeminiDocumentName(document.name) : null;
  if (!document || !parsed || parsed.storeName !== storeName ||
      (document.state !== undefined && (typeof document.state !== "string" || !DOCUMENT_STATES.has(document.state)))) throw failure();
  return document as Record<string, unknown> & { name: string };
}

async function findUniqueDocument(target: DiagnosticTarget, client: GeminiDiagnosticClient): Promise<string> {
  const pager = await client.fileSearchStores.documents.list({ parent: target.storeName, config: { pageSize: PAGE_SIZE } });
  const seenNames = new Set<string>();
  let matchName: string | null = null;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = pageNumber === 0 ? pager.page : await pager.nextPage();
    if (!Array.isArray(page) || page.length > PAGE_SIZE) throw failure();
    for (const raw of page) {
      const document = readDocument(raw, target.storeName);
      // Repeated rows make completeness uncertain, even if their names match.
      if (seenNames.has(document.name)) throw failure();
      seenNames.add(document.name);
      if (metadataMatches(document.customMetadata, target.metadata)) {
        if (matchName !== null || document.state !== "STATE_ACTIVE") throw failure();
        matchName = document.name;
      }
    }
    const more = pager.hasNextPage();
    if (typeof more !== "boolean") throw failure();
    if (!more) {
      if (matchName === null) throw failure();
      return matchName;
    }
  }
  // A match in a partial scan does not prove uniqueness.
  throw failure();
}

/** Server-only observation proof; callers must revalidate database authority before applying it. */
export async function verifyActiveGeminiDocument(
  target: DiagnosticTarget,
  apiKey: string,
  injectedClient?: GeminiDiagnosticClient,
): Promise<{ documentName: string; verifiedAt: number }> {
  try {
    validateTarget(target);
    if (!apiKey.trim()) throw failure();
    const client = injectedClient ?? defaultClient(apiKey);
    await requirePendingOperation(client, target.operationName);
    const documentName = await findUniqueDocument(target, client);
    const document = readDocument(await client.fileSearchStores.documents.get({ name: documentName }), target.storeName);
    if (document.name !== documentName || document.state !== "STATE_ACTIVE" || !metadataMatches(document.customMetadata, target.metadata)) throw failure();
    await requirePendingOperation(client, target.operationName);
    return { documentName, verifiedAt: Date.now() };
  } catch {
    // Never attach the provider error as cause: it can contain headers or response bodies.
    throw failure();
  }
}
