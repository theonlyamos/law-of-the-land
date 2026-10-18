import { GoogleGenAI, UploadToFileSearchStoreOperation } from "@google/genai";
import { isGeminiFileSearchStoreName, isGeminiUploadOperationForStore, parseGeminiDocumentName } from "../../lib/geminiFileSearchNames";
import type { DiagnosticTarget, GeminiDiagnosticClient } from "./geminiDiagnostic";

const PAGE_SIZE = 20;
const MAX_PAGES = 20;
const MAX_DOCUMENTS = PAGE_SIZE * MAX_PAGES;
const METADATA_KEYS = ["environment", "jurisdiction_id", "resource_id", "version_id", "version_number", "sha256"] as const;
type Metadata = DiagnosticTarget["metadata"];
export type FailedDocumentCoverageInput = {
  target: DiagnosticTarget;
  published: Array<{ documentName: string; metadata: Metadata }>;
  excluded: Array<{ metadata: Metadata; documentReference?: string }>;
};
export type FailedDocumentCoverageProof = {
  documentReference: string; operationReference: string;
  firstObservedAt: number; confirmedAt: number; coverageVerifiedAt: number; publishedCount: number;
};
type Document = { name: string; state: "STATE_ACTIVE" | "STATE_FAILED"; metadata: Metadata };
function failure(): Error { return new Error("GEMINI_FAILED_DOCUMENT_PROOF_FAILED"); }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function metadata(value: unknown): Metadata {
  const object = record(value);
  if (!object || Object.keys(object).length !== METADATA_KEYS.length ||
      !METADATA_KEYS.every(key => typeof object[key] === "string") ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(object.environment)) ||
      ![object.jurisdiction_id, object.resource_id, object.version_id].every(id => /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(String(id))) ||
      !/^[1-9]\d{0,10}$/.test(String(object.version_number)) || !/^[a-f0-9]{64}$/.test(String(object.sha256))) throw failure();
  return Object.fromEntries(METADATA_KEYS.map(key => [key, object[key]])) as Metadata;
}
function key(value: Metadata): string { return JSON.stringify(METADATA_KEYS.map(field => value[field])); }
function readDocument(value: unknown, storeName: string): Document {
  const document = record(value);
  const parsed = typeof document?.name === "string" ? parseGeminiDocumentName(document.name) : null;
  if (!document || !parsed || parsed.storeName !== storeName ||
      (document.state !== "STATE_ACTIVE" && document.state !== "STATE_FAILED") ||
      !Array.isArray(document.customMetadata) || document.customMetadata.length !== METADATA_KEYS.length) throw failure();
  const fields: Record<string, unknown> = {};
  for (const raw of document.customMetadata) {
    const entry = record(raw);
    if (!entry || typeof entry.key !== "string" || !METADATA_KEYS.includes(entry.key as typeof METADATA_KEYS[number]) ||
        Object.prototype.hasOwnProperty.call(fields, entry.key) || Object.keys(entry).some(field => field !== "key" && field !== "stringValue") ||
        typeof entry.stringValue !== "string") throw failure();
    fields[entry.key] = entry.stringValue;
  }
  return { name: document.name as string, state: document.state, metadata: metadata(fields) };
}
async function reference(value: string): Promise<string> {
  return `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
function clientFor(apiKey: string): GeminiDiagnosticClient {
  const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 10_000, retryOptions: { attempts: 1 } } });
  return { operations: { get: async ({ operation }) => await client.operations.get({ operation }) },
    fileSearchStores: { documents: { list: async input => await client.fileSearchStores.documents.list(input),
      get: async input => await client.fileSearchStores.documents.get(input) } } };
}
async function pendingOperation(client: GeminiDiagnosticClient, name: string): Promise<void> {
  const operation = new UploadToFileSearchStoreOperation(); operation.name = name;
  const response = record(await client.operations.get({ operation }));
  if (!response || response.name !== name || (response.done !== undefined && response.done !== false) ||
      response.error !== undefined || response.response !== undefined) throw failure();
}
function validateInput(input: FailedDocumentCoverageInput): void {
  const target = input?.target;
  if (!target || !isGeminiFileSearchStoreName(target.storeName) || !isGeminiUploadOperationForStore(target.operationName, target.storeName) ||
      !Array.isArray(input.published) || !Array.isArray(input.excluded) || input.published.length < 1 ||
      input.published.length + input.excluded.length + 1 > MAX_DOCUMENTS) throw failure();
  metadata(target.metadata);
  const seen = new Set([key(target.metadata)]);
  const names = new Set<string>();
  for (const expected of [...input.published, ...input.excluded]) {
    const identity = metadata(expected.metadata);
    if (identity.environment !== target.metadata.environment || identity.jurisdiction_id !== target.metadata.jurisdiction_id || seen.has(key(identity))) throw failure();
    seen.add(key(identity));
    if ("documentName" in expected) {
      const parsed = parseGeminiDocumentName(expected.documentName);
      if (!parsed || parsed.storeName !== target.storeName || names.has(expected.documentName)) throw failure();
      names.add(expected.documentName);
    } else if (expected.documentReference !== undefined && !/^sha256:[a-f0-9]{64}$/.test(expected.documentReference)) throw failure();
  }
}
async function scan(input: FailedDocumentCoverageInput, client: GeminiDiagnosticClient): Promise<Document[]> {
  const expected = new Map<string, { state: Document["state"]; name?: string; reference?: string }>();
  expected.set(key(input.target.metadata), { state: "STATE_FAILED" });
  for (const entry of input.published) expected.set(key(entry.metadata), { state: "STATE_ACTIVE", name: entry.documentName });
  for (const entry of input.excluded) expected.set(key(entry.metadata), { state: "STATE_FAILED", reference: entry.documentReference });
  const pager = await client.fileSearchStores.documents.list({ parent: input.target.storeName, config: { pageSize: PAGE_SIZE } });
  const names = new Set<string>(); const identities = new Set<string>(); const documents: Document[] = [];
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
    const page = pageIndex === 0 ? pager.page : await pager.nextPage();
    if (!Array.isArray(page) || page.length > PAGE_SIZE) throw failure();
    for (const raw of page) {
      const document = readDocument(raw, input.target.storeName); const identity = key(document.metadata); const entry = expected.get(identity);
      if (!entry || entry.state !== document.state || (entry.name !== undefined && entry.name !== document.name) ||
          (entry.reference !== undefined && entry.reference !== await reference(document.name)) ||
          names.has(document.name) || identities.has(identity)) throw failure();
      names.add(document.name); identities.add(identity); documents.push(document);
    }
    const more = pager.hasNextPage(); if (typeof more !== "boolean") throw failure();
    if (!more) {
      if (documents.length !== expected.size) throw failure();
      return documents.sort((left, right) => left.name.localeCompare(right.name));
    }
  }
  throw failure();
}
async function directProof(documents: Document[], input: FailedDocumentCoverageInput, client: GeminiDiagnosticClient): Promise<void> {
  // Bounded concurrency avoids a long serial proof window; no SDK retry is enabled.
  for (let start = 0; start < documents.length; start += 4) {
    await Promise.all(documents.slice(start, start + 4).map(async expected => {
      const current = readDocument(await client.fileSearchStores.documents.get({ name: expected.name }), input.target.storeName);
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw failure();
    }));
  }
}
/** A transient FAILED state is evidence only. Published-only retrieval must remain mandatory after recovery. */
export async function verifyFailedGeminiDocumentCoverage(
  input: FailedDocumentCoverageInput, apiKey: string, injectedClient?: GeminiDiagnosticClient,
): Promise<FailedDocumentCoverageProof> {
  try {
    validateInput(input); if (!apiKey.trim()) throw failure();
    const client = injectedClient ?? clientFor(apiKey);
    await pendingOperation(client, input.target.operationName);
    const first = await scan(input, client); await directProof(first, input, client); const firstObservedAt = Date.now();
    await pendingOperation(client, input.target.operationName);
    const second = await scan(input, client);
    if (JSON.stringify(first) !== JSON.stringify(second)) throw failure();
    await directProof(second, input, client);
    await pendingOperation(client, input.target.operationName);
    const target = second.find(document => key(document.metadata) === key(input.target.metadata)); if (!target) throw failure();
    const documentReference = await reference(target.name); const operationReference = await reference(input.target.operationName);
    const confirmedAt = Date.now();
    return { documentReference, operationReference, firstObservedAt, confirmedAt, coverageVerifiedAt: confirmedAt, publishedCount: input.published.length };
  } catch { throw failure(); }
}
