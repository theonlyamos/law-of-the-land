import { GoogleGenAI, UploadToFileSearchStoreOperation } from "@google/genai";
import { v, type Infer } from "convex/values";
import { isGeminiFileSearchStoreName, isGeminiUploadOperationForStore, parseGeminiDocumentName } from "../../lib/geminiFileSearchNames";

const PAGE_SIZE = 20;
const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 10_000;
const METADATA_KEYS = ["environment", "jurisdiction_id", "resource_id", "version_id", "version_number", "sha256"] as const;

export type DiagnosticTarget = {
  storeName: string;
  operationName: string;
  metadata: { environment: string; jurisdiction_id: string; resource_id: string; version_id: string; version_number: string; sha256: string };
};

type DiagnosticPager = {
  readonly page: unknown[];
  hasNextPage(): boolean;
  nextPage(): Promise<unknown[]>;
};

/** The diagnostic has no provider write methods or Convex mutation context. */
export type GeminiDiagnosticClient = {
  readonly operations: { get(request: { operation: UploadToFileSearchStoreOperation }): Promise<unknown> };
  readonly fileSearchStores: { readonly documents: {
    list(request: { parent: string; config: { pageSize: number } }): Promise<DiagnosticPager>;
    get(request: { name: string }): Promise<unknown>;
  } };
};

const requestErrorValidator = v.object({
  kind: v.union(v.literal("provider"), v.literal("invalid_response")),
  status: v.union(v.number(), v.null()),
});
const metadataValidator = v.object({
  environment: v.string(), jurisdiction_id: v.string(), resource_id: v.string(),
  version_id: v.string(), version_number: v.string(), sha256: v.string(),
});
const documentValidator = v.object({
  reference: v.string(),
  state: v.union(v.literal("STATE_PENDING"), v.literal("STATE_ACTIVE"), v.literal("STATE_FAILED"), v.literal("STATE_UNSPECIFIED"), v.literal("UNKNOWN")),
  sizeBytes: v.union(v.string(), v.null()), mimeType: v.union(v.string(), v.null()),
  createTime: v.union(v.string(), v.null()), updateTime: v.union(v.string(), v.null()),
  metadata: metadataValidator,
});

export const geminiDiagnosticResultValidator = v.object({
  operation: v.object({
    status: v.union(v.literal("ok"), v.literal("error")), reference: v.string(),
    done: v.union(v.boolean(), v.null()),
    error: v.union(v.object({ code: v.union(v.number(), v.null()), messagePresent: v.boolean() }), v.null()),
    response: v.union(v.object({
      documentReference: v.union(v.string(), v.null()), documentInExpectedStore: v.boolean(),
      metadataMatched: v.union(v.boolean(), v.null()), document: v.union(documentValidator, v.null()),
      requestError: v.union(requestErrorValidator, v.null()),
    }), v.null()),
    requestError: v.union(requestErrorValidator, v.null()),
  }),
  documents: v.object({
    scanComplete: v.boolean(), pagesScanned: v.number(), documentsScanned: v.number(),
    stateCounts: v.object({ pending: v.number(), active: v.number(), failed: v.number(), unspecified: v.number(), unknown: v.number() }),
    matchingCount: v.number(), duplicateMatches: v.boolean(), matches: v.array(documentValidator),
    requestError: v.union(requestErrorValidator, v.null()),
  }),
});

export type GeminiDiagnosticResult = Infer<typeof geminiDiagnosticResultValidator>;
type DiagnosticRequestError = Infer<typeof requestErrorValidator>;
type DiagnosticDocument = Infer<typeof documentValidator>;

function defaultClient(apiKey: string): GeminiDiagnosticClient {
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: REQUEST_TIMEOUT_MS, retryOptions: { attempts: 1 } },
  });
  return {
    operations: { get: async ({ operation }) => await client.operations.get({ operation }) },
    fileSearchStores: { documents: {
      list: async (request) => await client.fileSearchStores.documents.list(request),
      get: async (request) => await client.fileSearchStores.documents.get(request),
    } },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validateTarget(target: DiagnosticTarget): void {
  if (!target || !isGeminiFileSearchStoreName(target.storeName) || !isGeminiUploadOperationForStore(target.operationName, target.storeName)) {
    throw new Error("GEMINI_DIAGNOSTIC_TARGET_INVALID");
  }
  const metadata = record(target.metadata);
  if (
    !metadata || Object.keys(metadata).length !== METADATA_KEYS.length ||
    !METADATA_KEYS.every((key) => typeof metadata[key] === "string") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(target.metadata.environment) ||
    ![target.metadata.jurisdiction_id, target.metadata.resource_id, target.metadata.version_id].every((value) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value)) ||
    !/^[1-9]\d{0,10}$/.test(target.metadata.version_number) ||
    !/^[a-f0-9]{64}$/.test(target.metadata.sha256)
  ) throw new Error("GEMINI_DIAGNOSTIC_TARGET_INVALID");
}

async function reference(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function invalidResponse(): DiagnosticRequestError {
  return { kind: "invalid_response", status: null };
}

function requestError(error: unknown): DiagnosticRequestError {
  const candidate = record(error);
  const rawStatus = candidate?.status ?? candidate?.code;
  return {
    kind: "provider",
    status: typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null,
  };
}

function state(value: unknown): DiagnosticDocument["state"] {
  if (value === undefined || value === "STATE_UNSPECIFIED") return "STATE_UNSPECIFIED";
  return value === "STATE_PENDING" || value === "STATE_ACTIVE" || value === "STATE_FAILED" ? value : "UNKNOWN";
}

function metadataMatches(value: unknown, expected: DiagnosticTarget["metadata"]): boolean {
  if (!Array.isArray(value) || value.length > 20) return false;
  const entries = new Map<string, Record<string, unknown>>();
  for (const item of value) {
    const entry = record(item);
    if (!entry || typeof entry.key !== "string" || entries.has(entry.key)) return false;
    entries.set(entry.key, entry);
  }
  return METADATA_KEYS.every((key) => {
    const entry = entries.get(key);
    return entry?.stringValue === expected[key] &&
      Object.keys(entry).every((field) => field === "key" || field === "stringValue");
  });
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)) ? value : null;
}

async function matchingDocument(value: unknown, target: DiagnosticTarget, apiKey: string): Promise<DiagnosticDocument | null> {
  const document = record(value);
  const parsed = typeof document?.name === "string" ? parseGeminiDocumentName(document.name) : null;
  if (!document || !parsed || parsed.storeName !== target.storeName || !metadataMatches(document.customMetadata, target.metadata)) return null;
  const mimeType = typeof document.mimeType === "string" && document.mimeType.length <= 200 &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(document.mimeType) && !document.mimeType.includes(apiKey)
    ? document.mimeType : null;
  return {
    reference: await reference(document.name as string), state: state(document.state),
    sizeBytes: typeof document.sizeBytes === "string" && /^\d{1,20}$/.test(document.sizeBytes) ? document.sizeBytes : null,
    mimeType, createTime: timestamp(document.createTime), updateTime: timestamp(document.updateTime),
    // Expected values are already validated and every provider entry matched exactly.
    metadata: { ...target.metadata },
  };
}

async function inspectOperation(target: DiagnosticTarget, apiKey: string, client: GeminiDiagnosticClient): Promise<GeminiDiagnosticResult["operation"]> {
  const result: GeminiDiagnosticResult["operation"] = {
    status: "error", reference: await reference(target.operationName), done: null, error: null, response: null, requestError: null,
  };
  try {
    const operation = new UploadToFileSearchStoreOperation();
    operation.name = target.operationName;
    const raw = record(await client.operations.get({ operation }));
    if (!raw || raw.name !== target.operationName || (raw.done !== undefined && typeof raw.done !== "boolean")) {
      result.requestError = invalidResponse();
      return result;
    }
    result.status = "ok";
    result.done = raw.done === true;
    if (raw.error !== undefined) {
      const error = record(raw.error);
      result.error = {
        code: typeof error?.code === "number" && Number.isInteger(error.code) && error.code >= 1 && error.code <= 16 ? error.code : null,
        messagePresent: typeof error?.message === "string" && error.message.length > 0,
      };
    }
    if (raw.response !== undefined) {
      const response = record(raw.response);
      const name = typeof response?.documentName === "string" ? response.documentName : null;
      const parsed = name === null ? null : parseGeminiDocumentName(name);
      result.response = {
        documentReference: name !== null && parsed !== null ? await reference(name) : null,
        documentInExpectedStore: parsed?.storeName === target.storeName,
        metadataMatched: null, document: null, requestError: null,
      };
      if (name !== null && result.response.documentInExpectedStore) {
        try {
          const document = record(await client.fileSearchStores.documents.get({ name }));
          if (!document || document.name !== name) result.response.requestError = invalidResponse();
          else {
            result.response.document = await matchingDocument(document, target, apiKey);
            result.response.metadataMatched = result.response.document !== null;
          }
        } catch (error) { result.response.requestError = requestError(error); }
      }
    }
    // Preserve safe observations even when the provider contradicts its operation contract.
    if ((!result.done && (raw.error !== undefined || raw.response !== undefined)) ||
        (raw.error !== undefined && raw.response !== undefined) ||
        (result.done && raw.error === undefined && raw.response === undefined) ||
        (raw.error !== undefined && result.error?.code === null) ||
        (raw.response !== undefined && result.response?.documentInExpectedStore !== true)) {
      result.status = "error";
      result.requestError = invalidResponse();
    }
  } catch (error) { result.requestError = requestError(error); }
  return result;
}

async function inspectDocuments(target: DiagnosticTarget, apiKey: string, client: GeminiDiagnosticClient): Promise<GeminiDiagnosticResult["documents"]> {
  const result: GeminiDiagnosticResult["documents"] = {
    scanComplete: false, pagesScanned: 0, documentsScanned: 0,
    stateCounts: { pending: 0, active: 0, failed: 0, unspecified: 0, unknown: 0 },
    matchingCount: 0, duplicateMatches: false, matches: [], requestError: null,
  };
  const matchedNames = new Set<string>();
  try {
    const pager = await client.fileSearchStores.documents.list({ parent: target.storeName, config: { pageSize: PAGE_SIZE } });
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = pageNumber === 0 ? pager.page : await pager.nextPage();
      if (!Array.isArray(page) || page.length > PAGE_SIZE) {
        result.requestError = invalidResponse();
        break;
      }
      result.pagesScanned += 1;
      for (const raw of page) {
        result.documentsScanned += 1;
        const item = record(raw);
        const parsed = typeof item?.name === "string" ? parseGeminiDocumentName(item.name) : null;
        if (!item || parsed?.storeName !== target.storeName) {
          result.stateCounts.unknown += 1;
          result.requestError = invalidResponse();
          continue;
        }
        const documentState = state(item.state);
        const stateKey = { STATE_PENDING: "pending", STATE_ACTIVE: "active", STATE_FAILED: "failed", STATE_UNSPECIFIED: "unspecified", UNKNOWN: "unknown" } as const;
        result.stateCounts[stateKey[documentState]] += 1;
        const match = await matchingDocument(item, target, apiKey);
        if (match && !matchedNames.has(match.reference)) {
          matchedNames.add(match.reference);
          result.matches.push(match);
        }
      }
      if (!pager.hasNextPage()) {
        result.scanComplete = result.requestError === null;
        break;
      }
    }
  } catch (error) { result.requestError = requestError(error); }
  result.matchingCount = result.matches.length;
  result.duplicateMatches = result.matchingCount > 1;
  return result;
}

/** Observes only; deliberately does not infer a publication or recovery action. */
export async function inspectGeminiProvider(target: DiagnosticTarget, apiKey: string, injectedClient?: GeminiDiagnosticClient): Promise<GeminiDiagnosticResult> {
  validateTarget(target);
  if (!apiKey.trim()) throw new Error("GEMINI_DIAGNOSTIC_CREDENTIAL_UNAVAILABLE");
  const client = injectedClient ?? defaultClient(apiKey);
  const [operation, documents] = await Promise.all([
    inspectOperation(target, apiKey, client),
    inspectDocuments(target, apiKey, client),
  ]);
  return { operation, documents };
}
