import "server-only";

export const MAX_RETRIEVAL_LIBRARIES = 4;
export const MAX_RETRIEVAL_CONCURRENCY = 3;
export const MAX_GOVERNED_CONTEXT_LENGTH = 120_000;
export const SELECTED_CONTEXT_RESERVATION = 60_000;
export const DEFAULT_RETRIEVAL_TIMEOUT_MS = 10_000;
export const DEFAULT_TOTAL_RETRIEVAL_TIMEOUT_MS = 20_000;
const MAX_RAW_PROVIDER_CONTENT_LENGTH = 240_000;

export type ResearchRelation =
  | "selected"
  | "geographic_ancestor"
  | "organizational_geography";

export type ResearchAuthority = {
  jurisdictionId: string;
  name: string;
  kind: "geographic" | "organizational";
  relation: ResearchRelation;
};

export type RetrievalSettlement<TJob, TValue> =
  | { job: TJob; status: "fulfilled"; value: TValue }
  | { job: TJob; status: "rejected"; reason: unknown }
  | { job: TJob; status: "not_started" };

export type RetrievalExecutionOptions = {
  signal: AbortSignal;
  timeoutMs: number;
};

function validDeadline(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, 60_000) : fallback;
}

export async function runBoundedRetrieval<TJob extends { relation: ResearchRelation }, TValue>(
  input: readonly TJob[],
  execute: (job: TJob, options: RetrievalExecutionOptions) => Promise<TValue>,
  options: { perCallTimeoutMs?: number; totalTimeoutMs?: number } = {},
): Promise<Array<RetrievalSettlement<TJob, TValue>>> {
  const jobs = input.slice(0, MAX_RETRIEVAL_LIBRARIES);
  if (jobs.length === 0 || jobs[0].relation !== "selected") return [];
  const perCallTimeoutMs = validDeadline(
    options.perCallTimeoutMs,
    DEFAULT_RETRIEVAL_TIMEOUT_MS,
  );
  const totalTimeoutMs = validDeadline(
    options.totalTimeoutMs,
    DEFAULT_TOTAL_RETRIEVAL_TIMEOUT_MS,
  );
  const deadline = Date.now() + totalTimeoutMs;
  const settlements = jobs.map<RetrievalSettlement<TJob, TValue>>((job) => ({
    job,
    status: "not_started",
  }));
  let cursor = 0;
  let selectedFailed = false;

  async function worker() {
    while (!selectedFailed) {
      const index = cursor;
      if (index >= jobs.length || Date.now() >= deadline) return;
      cursor += 1;
      const job = jobs[index];
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const timeoutMs = Math.min(perCallTimeoutMs, remaining);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const value = await execute(job, { signal: controller.signal, timeoutMs });
        settlements[index] = { job, status: "fulfilled", value };
      } catch (reason) {
        settlements[index] = { job, status: "rejected", reason };
        if (index === 0) selectedFailed = true;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_RETRIEVAL_CONCURRENCY, jobs.length) },
      () => worker(),
    ),
  );
  return settlements;
}

export type GovernedSource = ResearchAuthority & {
  sourceRef: `J${1 | 2 | 3 | 4}`;
  content: string;
};

export type GovernedContextEnvelope = {
  version: 1;
  sources: GovernedSource[];
};

type SourceInput = ResearchAuthority & { content: string };

function normalizeParagraphs(value: string): string[] {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .split(/\n\s*\n/gu)
    .map((paragraph) => paragraph.replace(/[\t \f\v]+/gu, " ").replace(/ *\n */gu, "\n").trim())
    .filter(Boolean);
}

async function sha256Utf16CodeUnits(domain: "context-v1" | "paragraph-v1", value: string): Promise<string> {
  const framed = new ArrayBuffer(12 + (domain.length + value.length) * 2);
  const view = new DataView(framed);
  view.setUint32(0, 0x4c4f544c, false); // "LOTL", big-endian.
  view.setUint16(4, 1, false);
  view.setUint16(6, domain.length, false);
  view.setUint32(8, value.length, false);
  let offset = 12;
  for (const input of [domain, value]) {
    for (let index = 0; index < input.length; index += 1) {
      view.setUint16(offset, input.charCodeAt(index), false);
      offset += 2;
    }
  }
  const digest = await crypto.subtle.digest("SHA-256", framed);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function serialize(sources: GovernedSource[]): string {
  return JSON.stringify({ version: 1, sources } satisfies GovernedContextEnvelope);
}

function safePrefix(value: string, length: number): string {
  let end = Math.max(0, Math.min(value.length, length));
  const lastIncluded = end > 0 ? value.charCodeAt(end - 1) : 0;
  const firstOmitted = end < value.length ? value.charCodeAt(end) : 0;
  if (
    lastIncluded >= 0xd800 && lastIncluded <= 0xdbff
    && firstOmitted >= 0xdc00 && firstOmitted <= 0xdfff
  ) end -= 1;
  return value.slice(0, end);
}

function sourceFor(input: SourceInput, index: number, content: string): GovernedSource {
  return {
    sourceRef: `J${index + 1}` as GovernedSource["sourceRef"],
    jurisdictionId: input.jurisdictionId,
    name: input.name,
    kind: input.kind,
    relation: input.relation,
    content,
  };
}

function fitContent(
  inputs: readonly SourceInput[],
  contents: string[],
  index: number,
  candidate: string,
  cap = MAX_GOVERNED_CONTEXT_LENGTH,
): string {
  const attempt = (content: string) => serialize(
    inputs.flatMap((input, sourceIndex) => {
      const value = sourceIndex === index ? content : contents[sourceIndex];
      return value ? [sourceFor(input, sourceIndex, value)] : [];
    }),
  ).length <= cap;
  if (attempt(candidate)) return candidate;
  let low = 0;
  let high = candidate.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (attempt(safePrefix(candidate, middle))) low = middle;
    else high = middle - 1;
  }
  return safePrefix(candidate, low);
}

export async function buildGovernedContext(
  rawInputs: readonly SourceInput[],
): Promise<{ serialized: string; digest: string; sources: GovernedSource[] }> {
  const inputs = rawInputs.slice(0, MAX_RETRIEVAL_LIBRARIES);
  if (inputs.length === 0 || inputs[0].relation !== "selected") {
    throw new Error("GOVERNED_CONTEXT_SELECTED_REQUIRED");
  }
  const seen = new Set<string>();
  const normalized: SourceInput[] = [];
  for (const input of inputs) {
    const retained: string[] = [];
    for (const paragraph of normalizeParagraphs(safePrefix(input.content, MAX_RAW_PROVIDER_CONTENT_LENGTH))) {
      const digest = await sha256Utf16CodeUnits("paragraph-v1", paragraph);
      if (seen.has(digest)) continue;
      seen.add(digest);
      retained.push(paragraph);
    }
    normalized.push({ ...input, content: retained.join("\n\n") });
  }

  const contents = normalized.map(() => "");
  const selectedTarget = safePrefix(normalized[0].content, SELECTED_CONTEXT_RESERVATION);
  contents[0] = fitContent(normalized, contents, 0, selectedTarget);

  const supplementaryIndexes = normalized
    .map((source, index) => source.content && index > 0 ? index : -1)
    .filter((index) => index > 0);
  if (supplementaryIndexes.length > 0) {
    let low = 0;
    let high = Math.max(...supplementaryIndexes.map((index) => normalized[index].content.length));
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidates = [...contents];
      for (const index of supplementaryIndexes) {
        candidates[index] = safePrefix(normalized[index].content, middle);
      }
      const length = serialize(normalized.flatMap((input, index) =>
        candidates[index] ? [sourceFor(input, index, candidates[index])] : [],
      )).length;
      if (length <= MAX_GOVERNED_CONTEXT_LENGTH) low = middle;
      else high = middle - 1;
    }
    for (const index of supplementaryIndexes) {
      contents[index] = safePrefix(normalized[index].content, low);
    }
  }

  contents[0] = fitContent(normalized, contents, 0, normalized[0].content);
  for (let index = 1; index < normalized.length; index += 1) {
    contents[index] = fitContent(normalized, contents, index, normalized[index].content);
  }

  const sources = normalized.flatMap((input, index) =>
    contents[index] ? [sourceFor(input, index, contents[index])] : [],
  );
  const serialized = serialize(sources);
  if (serialized.length > MAX_GOVERNED_CONTEXT_LENGTH) {
    throw new Error("GOVERNED_CONTEXT_LIMIT_EXCEEDED");
  }
  return { serialized, digest: await sha256Utf16CodeUnits("context-v1", serialized), sources };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

export function parseGovernedContext(value: string): GovernedContextEnvelope {
  if (!value || value.length > MAX_GOVERNED_CONTEXT_LENGTH) throw new Error("GOVERNED_CONTEXT_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("GOVERNED_CONTEXT_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("GOVERNED_CONTEXT_INVALID");
  const envelope = parsed as Record<string, unknown>;
  if (!exactKeys(envelope, ["sources", "version"]) || envelope.version !== 1 || !Array.isArray(envelope.sources) || envelope.sources.length > 4) {
    throw new Error("GOVERNED_CONTEXT_INVALID");
  }
  const refs = new Set<string>();
  const ids = new Set<string>();
  const sources = envelope.sources.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("GOVERNED_CONTEXT_INVALID");
    const source = raw as Record<string, unknown>;
    if (!exactKeys(source, ["content", "jurisdictionId", "kind", "name", "relation", "sourceRef"])) throw new Error("GOVERNED_CONTEXT_INVALID");
    if (
      typeof source.sourceRef !== "string" || !/^J[1-4]$/u.test(source.sourceRef) || refs.has(source.sourceRef) ||
      typeof source.jurisdictionId !== "string" || !source.jurisdictionId || ids.has(source.jurisdictionId) ||
      typeof source.name !== "string" || !source.name || source.name.length > 200 ||
      (source.kind !== "geographic" && source.kind !== "organizational") ||
      (source.relation !== "selected" && source.relation !== "geographic_ancestor" && source.relation !== "organizational_geography") ||
      typeof source.content !== "string" || !source.content
    ) throw new Error("GOVERNED_CONTEXT_INVALID");
    refs.add(source.sourceRef);
    ids.add(source.jurisdictionId);
    return source as GovernedSource;
  });
  return { version: 1, sources };
}

export async function digestExactContext(value: string): Promise<string> {
  return await sha256Utf16CodeUnits("context-v1", value);
}
