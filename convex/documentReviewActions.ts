"use node";

import { GoogleGenAI } from "@google/genai";
import { makeFunctionReference } from "convex/server";
import { v, type Infer } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { buildPublicationMetadataFilter } from "../shared/gemini-publication-filter";
import { DOCUMENT_REVIEW_LIMITS as LIMITS, type DocumentReviewFailure } from "../shared/document-review";
import {
  CHECK_INSTRUCTION,
  DEFAULT_DOCUMENT_REVIEW_MODEL,
  GAPS_INSTRUCTION,
  READING_INSTRUCTION,
  READING_SCHEMA,
  SUMMARY_INSTRUCTION,
  SUMMARY_SCHEMA,
  checkPrompt,
  fallbackSummary,
  gapsPrompt,
  interactionOutput,
  interactionPlainText,
  parseCheckOutput,
  parseReading,
  parseSummary,
  readingPrompt,
  summaryPrompt,
  type ProposedFinding,
  type ReadingResult,
} from "./lib/documentReviewModel";
import type { readingResultValidator } from "./lib/documentReviewContracts";

type ReviewArgs = { reviewId: Id<"documentReviews">; attempt: number };
type ReadingInput = {
  storageId: Id<"_storage">; filename: string; mimeType: string; kind: "document" | "text" | "image";
  byteSize: number; extractedText?: string; question: string; jurisdictionName: string;
} | null;
type CheckingInput = {
  context: Parameters<typeof checkPrompt>[0];
  passages: { ordinal: number; ref?: string; heading?: string; text: string }[];
  outline: { ref?: string; heading?: string; topics: string[] }[];
  research: { stores: { jurisdictionId: Id<"jurisdictions">; storeName: string; publicationFilter?: Parameters<typeof buildPublicationMetadataFilter>[0][number]["publicationFilter"] }[] } | null;
  alreadyChecked: number[];
} | null;
type SummaryInput = {
  documentType: string; question: string; role: string; jurisdictionName: string;
  findings: Parameters<typeof summaryPrompt>[0]["findings"][number][];
  counts: Parameters<typeof fallbackSummary>[0];
} | null;

const readingInputRef = makeFunctionReference<"query", ReviewArgs, ReadingInput>("documentReviews:readingInput");
const saveReadingRef = makeFunctionReference<"mutation", ReviewArgs & { reading: Infer<typeof readingResultValidator> }, null>("documentReviews:saveReading");
const checkingInputRef = makeFunctionReference<"query", ReviewArgs, CheckingInput>("documentReviews:checkingInput");
const saveFindingsRef = makeFunctionReference<"mutation">("documentReviews:saveFindings");
const summaryInputRef = makeFunctionReference<"query", ReviewArgs, SummaryInput>("documentReviews:summaryInput");
const completeRef = makeFunctionReference<"mutation">("documentReviews:complete");
const failRef = makeFunctionReference<"mutation", ReviewArgs & { failure: DocumentReviewFailure }, null>("documentReviews:fail");

const READING_TIMEOUT_MS = 240_000;
const CHECK_TIMEOUT_MS = 150_000;
const SUMMARY_TIMEOUT_MS = 45_000;
/** Convex stops actions at 10 minutes. Checking must end by this point, leaving room for the summary and saving. */
const CHECK_BUDGET_MS = 8 * 60_000;
/** The summary and final save must finish before this point. */
const ACTION_LIMIT_MS = 9 * 60_000 + 30_000;
/** A checking request is not started with less time than this left. */
const MIN_REQUEST_MS = 20_000;

class BudgetExhausted extends Error {}

type Client = Pick<GoogleGenAI, "interactions">;
type CreateParams = Parameters<GoogleGenAI["interactions"]["create"]>[0];

function model(): string {
  return process.env.DOCUMENT_REVIEW_MODEL?.trim() || process.env.GEMINI_AI_MODEL?.trim() || DEFAULT_DOCUMENT_REVIEW_MODEL;
}

/** Status and a short message from a provider error, for logs. Never includes the request. */
function providerErrorDetail(error: unknown): { status?: number; name: string; message: string } {
  const status = typeof (error as { status?: unknown } | null)?.status === "number" ? (error as { status: number }).status : undefined;
  const name = error instanceof Error ? error.name : "unknown";
  const message = error instanceof Error ? error.message.replace(/\s+/gu, " ").slice(0, 300) : "";
  return { ...(status === undefined ? {} : { status }), name, message };
}

function isRequestRejected(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 400 || /invalid argument|schema|too many states/iu.test(error instanceof Error ? error.message : "");
}

function failureFor(error: unknown): DocumentReviewFailure {
  const text = error instanceof Error ? `${error.name} ${error.message}` : "";
  if (/timeout|timed out|deadline/iu.test(text)) return "timeout";
  return "provider";
}

async function fail(ctx: ActionCtx, args: ReviewArgs, failure: DocumentReviewFailure) {
  await ctx.runMutation(failRef, { ...args, failure });
}

function readingResultForStorage(reading: ReadingResult): Infer<typeof readingResultValidator> {
  return {
    ...reading,
    suggestedFocusIds: reading.suggestedFocusIds,
    segments: reading.segments.map((segment) => ({ ...segment })),
  };
}

/** Reads the uploaded document into a profile and passages. */
export const read = internalAction({
  args: { reviewId: v.id("documentReviews"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const input = await ctx.runQuery(readingInputRef, args);
    if (!input) return null;
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) { await fail(ctx, args, "not_configured"); return null; }
    if (input.byteSize > 10 * 1024 * 1024 || (input.extractedText?.length ?? 0) > 100_000) { await fail(ctx, args, "too_large"); return null; }

    const parts: unknown[] = [];
    let text: string | undefined;
    if (input.extractedText !== undefined) {
      text = input.extractedText;
    } else if (input.kind === "document" || input.kind === "image") {
      const blob = await ctx.storage.get(input.storageId);
      if (!blob) { await fail(ctx, args, "unreadable"); return null; }
      const data = Buffer.from(await blob.arrayBuffer()).toString("base64");
      parts.push({ type: input.kind, mime_type: input.mimeType, data });
    } else {
      await fail(ctx, args, "unreadable");
      return null;
    }
    parts.unshift({ type: "text", text: readingPrompt({
      question: input.question, filename: input.filename, mimeType: input.mimeType, jurisdictionName: input.jurisdictionName,
      ...(text === undefined ? {} : { text }),
    }) });

    const client: Client = new GoogleGenAI({ apiKey });
    let reading: ReadingResult | null = null;
    let lastError: unknown;
    // One retry covers a malformed or truncated response, within the action's time limit.
    // If the provider rejects the response schema, the retry asks for plain JSON instead.
    let useSchema = true;
    for (let attempt = 0; attempt < 2 && !reading; attempt++) {
      const timeout = Math.min(READING_TIMEOUT_MS, startedAt + ACTION_LIMIT_MS - Date.now());
      if (timeout < MIN_REQUEST_MS) break;
      try {
        const response = await client.interactions.create({
          model: model(),
          input: parts,
          system_instruction: READING_INSTRUCTION,
          tools: [],
          store: false,
          stream: false,
          generation_config: { thinking_level: "low", thinking_summaries: "none", tool_choice: "none", max_output_tokens: 32_768 },
          response_format: { type: "text", mime_type: "application/json", ...(useSchema ? { schema: READING_SCHEMA } : {}) },
        } as unknown as CreateParams, { maxRetries: 0, timeout });
        const output = interactionPlainText(response);
        reading = output ? parseReading(output) : null;
        if (!reading) console.warn("document_review_read", JSON.stringify({ outcome: "invalid_response", attempt, schema: useSchema }));
      } catch (error) {
        lastError = error;
        console.warn("document_review_read", JSON.stringify({ outcome: "provider_error", attempt, schema: useSchema, ...providerErrorDetail(error) }));
        if (isRequestRejected(error)) useSchema = false;
      }
    }
    if (!reading) {
      await fail(ctx, args, lastError ? failureFor(lastError) : "unreadable");
      return null;
    }
    await ctx.runMutation(saveReadingRef, { ...args, reading: readingResultForStorage(reading) });
    console.info("document_review_read", JSON.stringify({ outcome: "ok", segments: reading.segments.length }));
    return null;
  },
});

async function runChecks<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  }));
}

function placeholder(passage: { ordinal: number; ref?: string; heading?: string }): ProposedFinding {
  return {
    segmentOrdinal: passage.ordinal,
    kind: "passage",
    status: "unconfirmed",
    title: passage.heading || (passage.ref ? `Passage ${passage.ref}` : "Passage"),
    meaning: "We couldn't check this passage against the library this time.",
    lawSummary: "",
    recommendation: "Ask a follow-up question about this passage, or run the review again.",
    citations: [],
    provisions: [],
  };
}

/** Checks the selected passages (and what is missing) against the law, then writes the summary. */
export const check = internalAction({
  args: { reviewId: v.id("documentReviews"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const input = await ctx.runQuery(checkingInputRef, args);
    if (!input) return null;
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) { await fail(ctx, args, "not_configured"); return null; }
    const stores = input.research?.stores ?? [];
    if (stores.length === 0) { await fail(ctx, args, "research_unavailable"); return null; }
    let metadataFilter: string | undefined;
    try { metadataFilter = buildPublicationMetadataFilter(stores); }
    catch { await fail(ctx, args, "research_unavailable"); return null; }

    const client: Client = new GoogleGenAI({ apiKey });
    const tool = {
      type: "file_search",
      file_search_store_names: stores.map((store) => store.storeName),
      ...(metadataFilter === undefined ? {} : { metadata_filter: metadataFilter }),
    };
    const remaining = () => startedAt + CHECK_BUDGET_MS - Date.now();
    // Every request is bounded by the time left, so the action always reaches a final state.
    const ask = async (instruction: string, prompt: string) => {
      const timeout = Math.min(CHECK_TIMEOUT_MS, remaining());
      if (timeout < MIN_REQUEST_MS) throw new BudgetExhausted();
      const response = await client.interactions.create({
        model: model(),
        input: { type: "text", text: prompt },
        system_instruction: instruction,
        tools: [tool],
        store: false,
        stream: false,
        generation_config: { max_output_tokens: 16_384 },
      } as unknown as CreateParams, { maxRetries: 0, timeout });
      return interactionOutput(response, stores);
    };
    // Counts only, so citation problems can be traced from the logs without document content.
    const logCheck = (step: "passages" | "gaps", output: Awaited<ReturnType<typeof ask>>, parsed: ReturnType<typeof parseCheckOutput>) => {
      const statuses: Record<string, number> = {};
      for (const finding of parsed?.findings ?? []) statuses[finding.status] = (statuses[finding.status] ?? 0) + 1;
      console.info("document_review_check", JSON.stringify({
        step, outcome: parsed ? "ok" : output ? "invalid_response" : "empty",
        searches: output?.searches ?? 0, citationsSeen: output?.citationsSeen ?? 0, citationsKept: output?.annotations.length ?? 0,
        findings: parsed?.findings.length ?? 0, findingsWithCitations: parsed?.findings.filter((finding) => finding.citations.length > 0).length ?? 0,
        pool: parsed?.pool.length ?? 0, statuses,
      }));
    };

    const done = new Set(input.alreadyChecked);
    const passages = input.passages.filter((passage) => !done.has(passage.ordinal));
    const batches: (typeof passages)[] = [];
    for (let index = 0; index < passages.length; index += LIMITS.checkBatchSize) {
      batches.push(passages.slice(index, index + LIMITS.checkBatchSize));
    }
    let stopped = false;
    let providerErrors = 0;
    const save = async (findings: ProposedFinding[], pool: unknown[], checkedOrdinals: number[]) => {
      try {
        await ctx.runMutation(saveFindingsRef, { ...args, findings, pool, checkedOrdinals });
      } catch (error) {
        console.warn("document_review_save", JSON.stringify({ outcome: "save_error", message: error instanceof Error ? error.name : "unknown" }));
      }
    };

    const checkBatch = async (batch: typeof passages) => {
      if (stopped || remaining() < MIN_REQUEST_MS) {
        stopped = true;
        await save(batch.map(placeholder), [], batch.map((passage) => passage.ordinal));
        return;
      }
      let parsed: ReturnType<typeof parseCheckOutput> = null;
      for (let attempt = 0; attempt < 2 && !parsed && !stopped; attempt++) {
        try {
          const output = await ask(CHECK_INSTRUCTION, checkPrompt(input.context, batch));
          parsed = output ? parseCheckOutput(output, { kind: "passage", passageOrdinals: batch.map((passage) => passage.ordinal) }) : null;
          logCheck("passages", output, parsed);
        } catch (error) {
          if (error instanceof BudgetExhausted) stopped = true;
          else {
            providerErrors += 1;
            if (providerErrors <= 3) console.warn("document_review_check", JSON.stringify({ outcome: "provider_error", ...providerErrorDetail(error) }));
          }
        }
      }
      const findings = parsed?.findings ?? [];
      const covered = new Set(findings.map((finding) => finding.segmentOrdinal));
      for (const passage of batch) if (!covered.has(passage.ordinal)) findings.push(placeholder(passage));
      await save(findings, parsed?.pool ?? [], batch.map((passage) => passage.ordinal));
    };

    const checkGaps = async () => {
      if (input.alreadyChecked.length > 0) return; // A resumed review already looked for gaps.
      try {
        const output = await ask(GAPS_INSTRUCTION, gapsPrompt(input.context, input.outline));
        const parsed = output ? parseCheckOutput(output, { kind: "missing", passageOrdinals: [] }) : null;
        logCheck("gaps", output, parsed);
        if (parsed?.findings.length) await save(parsed.findings, parsed.pool, []);
      } catch (error) {
        if (!(error instanceof BudgetExhausted)) {
          providerErrors += 1;
          if (providerErrors <= 3) console.warn("document_review_check", JSON.stringify({ outcome: "provider_error", step: "gaps", ...providerErrorDetail(error) }));
        }
      }
    };

    await Promise.all([
      checkGaps(),
      runChecks(batches, LIMITS.checkConcurrency, checkBatch),
    ]);

    const summaryInput = await ctx.runQuery(summaryInputRef, args);
    if (!summaryInput) return null; // Cancelled, deleted or retried meanwhile.
    if (summaryInput.findings.every((finding) => finding.status === "unconfirmed") && providerErrors > 0) {
      await fail(ctx, args, "provider");
      return null;
    }
    let summary = null;
    const summaryTimeout = Math.min(SUMMARY_TIMEOUT_MS, startedAt + ACTION_LIMIT_MS - Date.now());
    if (summaryTimeout >= 10_000) try {
      const response = await client.interactions.create({
        model: model(),
        input: { type: "text", text: summaryPrompt(summaryInput) },
        system_instruction: SUMMARY_INSTRUCTION,
        tools: [],
        store: false,
        stream: false,
        generation_config: { thinking_level: "low", thinking_summaries: "none", tool_choice: "none", max_output_tokens: 2_048 },
        response_format: { type: "text", mime_type: "application/json", schema: SUMMARY_SCHEMA },
      } as unknown as CreateParams, { maxRetries: 0, timeout: summaryTimeout });
      const output = interactionPlainText(response);
      summary = output ? parseSummary(output) : null;
    } catch {
      summary = null;
    }
    summary ??= fallbackSummary(summaryInput.counts, summaryInput.documentType);
    await ctx.runMutation(completeRef, { ...args, ...summary });
    console.info("document_review_check", JSON.stringify({
      outcome: "ok", batches: batches.length, providerErrors, elapsedMs: Date.now() - startedAt, stopped,
    }));
    return null;
  },
});
