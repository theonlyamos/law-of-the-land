"use node";

import { GoogleGenAI } from "@google/genai";
import { makeFunctionReference } from "convex/server";
import { v, type Infer } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { buildPublicationMetadataFilter } from "../shared/gemini-publication-filter";
import { DOCUMENT_DRAFT_LIMITS as LIMITS, type DocumentDraftFailure } from "../shared/document-draft";
import { DEFAULT_DOCUMENT_REVIEW_MODEL, interactionOutput, interactionPlainText } from "./lib/documentReviewModel";
import {
  FORMALITIES_INSTRUCTION,
  PLAN_INSTRUCTION,
  PLAN_SCHEMA,
  draftInstruction,
  draftPrompt,
  formalitiesPrompt,
  parseDraftOutput,
  parseFormalities,
  parsePlan,
  placeholderClause,
  planPrompt,
  reviseInstruction,
  revisePrompt,
  type DraftContext,
  type DraftPlan,
  type DraftSection,
  type ProposedClause,
} from "./lib/documentDraftModel";
import type { researchSnapshotValidator } from "./lib/documentReviewContracts";

type DraftArgs = { draftId: Id<"documentDrafts">; attempt: number };
type Research = Infer<typeof researchSnapshotValidator> | null;
type PlanningInput = {
  request: string; jurisdictionName: string; context: string;
  attachment?: { storageId: Id<"_storage">; filename: string; mimeType: string; kind: "document" | "text" | "image"; byteSize: number; extractedText?: string };
} | null;
type DraftingInput = {
  context: DraftContext;
  sections: { ordinal: number; heading: string; purpose: string; kind: DraftSection["kind"] }[];
  research: Research;
  alreadyDrafted: number[];
  hasFormalities: boolean;
} | null;
type RevisionArgs = { clauseId: Id<"documentDraftClauses">; revision: number };
type RevisionInput = { context: DraftContext; clause: { ordinal: number; heading: string; text: string }; research: Research } | null;

const planningInputRef = makeFunctionReference<"query", DraftArgs, PlanningInput>("documentDrafts:planningInput");
const savePlanRef = makeFunctionReference<"mutation", DraftArgs & { plan: DraftPlan }, null>("documentDrafts:savePlan");
const draftingInputRef = makeFunctionReference<"query", DraftArgs, DraftingInput>("documentDrafts:draftingInput");
const saveClausesRef = makeFunctionReference<"mutation">("documentDrafts:saveClauses");
const saveFormalitiesRef = makeFunctionReference<"mutation">("documentDrafts:saveFormalities");
const completeRef = makeFunctionReference<"mutation", DraftArgs, null>("documentDrafts:complete");
const failRef = makeFunctionReference<"mutation", DraftArgs & { failure: DocumentDraftFailure }, null>("documentDrafts:fail");
const revisionInputRef = makeFunctionReference<"query", RevisionArgs, RevisionInput>("documentDrafts:revisionInput");
const saveRevisionRef = makeFunctionReference<"mutation">("documentDrafts:saveRevision");
const failRevisionRef = makeFunctionReference<"mutation", RevisionArgs, null>("documentDrafts:failRevision");

const PLAN_TIMEOUT_MS = 180_000;
const DRAFT_TIMEOUT_MS = 150_000;
const REVISE_TIMEOUT_MS = 120_000;
/** Convex stops actions at 10 minutes. Drafting must end by this point, leaving room for saving. */
const DRAFT_BUDGET_MS = 8 * 60_000 + 30_000;
const ACTION_LIMIT_MS = 9 * 60_000 + 30_000;
/** A drafting request is not started with less time than this left. */
const MIN_REQUEST_MS = 20_000;

class BudgetExhausted extends Error {}

type Client = Pick<GoogleGenAI, "interactions">;
type CreateParams = Parameters<GoogleGenAI["interactions"]["create"]>[0];

function model(): string {
  return process.env.DOCUMENT_DRAFT_MODEL?.trim() || process.env.DOCUMENT_REVIEW_MODEL?.trim() || process.env.GEMINI_AI_MODEL?.trim() || DEFAULT_DOCUMENT_REVIEW_MODEL;
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

function failureFor(error: unknown): DocumentDraftFailure {
  const text = error instanceof Error ? `${error.name} ${error.message}` : "";
  return /timeout|timed out|deadline/iu.test(text) ? "timeout" : "provider";
}

function fileSearchTool(research: Research): { tool: Record<string, unknown>; stores: NonNullable<Research>["stores"] } | null {
  const stores = research?.stores ?? [];
  if (stores.length === 0) return null;
  let metadataFilter: string | undefined;
  try { metadataFilter = buildPublicationMetadataFilter(stores); } catch { return null; }
  return {
    stores,
    tool: {
      type: "file_search",
      file_search_store_names: stores.map((store) => store.storeName),
      ...(metadataFilter === undefined ? {} : { metadata_filter: metadataFilter }),
    },
  };
}

async function runInParallel<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  }));
}

/** Works out the document's type, structure and the questions to ask. */
export const plan = internalAction({
  args: { draftId: v.id("documentDrafts"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const input = await ctx.runQuery(planningInputRef, args);
    if (!input) return null;
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) { await ctx.runMutation(failRef, { ...args, failure: "not_configured" }); return null; }

    const parts: unknown[] = [];
    let attachment: { filename: string; mimeType: string; text?: string } | undefined;
    if (input.attachment) {
      const file = input.attachment;
      if (file.byteSize > 10 * 1024 * 1024 || (file.extractedText?.length ?? 0) > 100_000) {
        await ctx.runMutation(failRef, { ...args, failure: "too_large" });
        return null;
      }
      attachment = { filename: file.filename, mimeType: file.mimeType, ...(file.extractedText === undefined ? {} : { text: file.extractedText }) };
      if (file.extractedText === undefined) {
        if (file.kind === "text") { await ctx.runMutation(failRef, { ...args, failure: "unreadable" }); return null; }
        const blob = await ctx.storage.get(file.storageId);
        if (!blob) { await ctx.runMutation(failRef, { ...args, failure: "unreadable" }); return null; }
        parts.push({ type: file.kind, mime_type: file.mimeType, data: Buffer.from(await blob.arrayBuffer()).toString("base64") });
      }
    }
    parts.unshift({ type: "text", text: planPrompt({
      request: input.request, jurisdictionName: input.jurisdictionName,
      ...(input.context ? { context: input.context } : {}), ...(attachment ? { attachment } : {}),
    }) });

    const client: Client = new GoogleGenAI({ apiKey });
    let planned: DraftPlan | null = null;
    let lastError: unknown;
    let useSchema = true;
    // One retry covers a malformed or truncated response; a rejected schema retries as plain JSON.
    for (let attempt = 0; attempt < 2 && !planned; attempt++) {
      const timeout = Math.min(PLAN_TIMEOUT_MS, startedAt + ACTION_LIMIT_MS - Date.now());
      if (timeout < MIN_REQUEST_MS) break;
      try {
        const response = await client.interactions.create({
          model: model(),
          input: parts,
          system_instruction: PLAN_INSTRUCTION,
          tools: [],
          store: false,
          stream: false,
          generation_config: { thinking_level: "low", thinking_summaries: "none", tool_choice: "none", max_output_tokens: 16_384 },
          response_format: { type: "text", mime_type: "application/json", ...(useSchema ? { schema: PLAN_SCHEMA } : {}) },
        } as unknown as CreateParams, { maxRetries: 0, timeout });
        const output = interactionPlainText(response);
        planned = output ? parsePlan(output) : null;
        if (!planned) console.warn("document_draft_plan", JSON.stringify({ outcome: "invalid_response", attempt, schema: useSchema }));
      } catch (error) {
        lastError = error;
        console.warn("document_draft_plan", JSON.stringify({ outcome: "provider_error", attempt, schema: useSchema, ...providerErrorDetail(error) }));
        if (isRequestRejected(error)) useSchema = false;
      }
    }
    if (!planned) {
      await ctx.runMutation(failRef, { ...args, failure: lastError ? failureFor(lastError) : "provider" });
      return null;
    }
    await ctx.runMutation(savePlanRef, { ...args, plan: planned });
    console.info("document_draft_plan", JSON.stringify({ outcome: "ok", sections: planned.sections.length, questions: planned.questions.length }));
    return null;
  },
});

function clauseForStorage(clause: ProposedClause) {
  return { ...clause, citations: clause.citations.map((citation) => ({ ...citation })) };
}

/** Drafts every planned section against the law, then lists the formalities. */
export const draft = internalAction({
  args: { draftId: v.id("documentDrafts"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const input = await ctx.runQuery(draftingInputRef, args);
    if (!input) return null;
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) { await ctx.runMutation(failRef, { ...args, failure: "not_configured" }); return null; }
    const search = fileSearchTool(input.research);
    if (!search) { await ctx.runMutation(failRef, { ...args, failure: "research_unavailable" }); return null; }

    const client: Client = new GoogleGenAI({ apiKey });
    const remaining = () => startedAt + DRAFT_BUDGET_MS - Date.now();
    const ask = async (instruction: string, prompt: string) => {
      const timeout = Math.min(DRAFT_TIMEOUT_MS, remaining());
      if (timeout < MIN_REQUEST_MS) throw new BudgetExhausted();
      const response = await client.interactions.create({
        model: model(),
        input: { type: "text", text: prompt },
        system_instruction: instruction,
        tools: [search.tool],
        store: false,
        stream: false,
        generation_config: { max_output_tokens: 24_576 },
      } as unknown as CreateParams, { maxRetries: 0, timeout });
      return interactionOutput(response, search.stores);
    };

    const done = new Set(input.alreadyDrafted);
    const pending = input.sections.filter((section) => !done.has(section.ordinal));
    const batches: (typeof pending)[] = [];
    for (let index = 0; index < pending.length; index += LIMITS.draftBatchSize) batches.push(pending.slice(index, index + LIMITS.draftBatchSize));
    let stopped = false;
    let providerErrors = 0;
    let drafted = 0;
    const instruction = draftInstruction(input.context.audience);

    const save = async (clauses: ProposedClause[], pool: unknown[], draftedOrdinals: number[]) => {
      try {
        await ctx.runMutation(saveClausesRef, { ...args, clauses: clauses.map(clauseForStorage), pool, draftedOrdinals });
      } catch (error) {
        console.warn("document_draft_save", JSON.stringify({ outcome: "save_error", message: error instanceof Error ? error.name : "unknown" }));
      }
    };

    const draftBatch = async (batch: typeof pending) => {
      if (stopped || remaining() < MIN_REQUEST_MS) {
        stopped = true;
        await save(batch.map(placeholderClause), [], batch.map((section) => section.ordinal));
        return;
      }
      let parsed: ReturnType<typeof parseDraftOutput> = null;
      for (let attempt = 0; attempt < 2 && !parsed && !stopped; attempt++) {
        try {
          const output = await ask(instruction, draftPrompt(input.context, batch));
          parsed = output ? parseDraftOutput(output, batch.map((section) => section.ordinal)) : null;
          console.info("document_draft_write", JSON.stringify({
            outcome: parsed ? "ok" : output ? "invalid_response" : "empty",
            searches: output?.searches ?? 0, citationsSeen: output?.citationsSeen ?? 0, citationsKept: output?.annotations.length ?? 0,
            clauses: parsed?.clauses.length ?? 0, clausesWithCitations: parsed?.clauses.filter((clause) => clause.citations.length > 0).length ?? 0,
          }));
        } catch (error) {
          if (error instanceof BudgetExhausted) stopped = true;
          else {
            providerErrors += 1;
            if (providerErrors <= 3) console.warn("document_draft_write", JSON.stringify({ outcome: "provider_error", ...providerErrorDetail(error) }));
          }
        }
      }
      const clauses = parsed?.clauses ?? [];
      drafted += clauses.length;
      const covered = new Set(clauses.map((clause) => clause.sectionOrdinal));
      for (const section of batch) if (!covered.has(section.ordinal)) clauses.push(placeholderClause(section));
      await save(clauses, parsed?.pool ?? [], batch.map((section) => section.ordinal));
    };

    const listFormalities = async () => {
      if (input.hasFormalities) return; // A resumed draft already listed them.
      try {
        const output = await ask(FORMALITIES_INSTRUCTION, formalitiesPrompt(input.context));
        const parsed = output ? parseFormalities(output) : null;
        await ctx.runMutation(saveFormalitiesRef, {
          ...args,
          items: (parsed?.items ?? []).map((item) => ({ ...item, citations: item.citations.map((citation) => ({ ...citation })) })),
          pool: parsed?.pool ?? [],
        });
      } catch (error) {
        if (!(error instanceof BudgetExhausted)) {
          providerErrors += 1;
          if (providerErrors <= 3) console.warn("document_draft_formalities", JSON.stringify({ outcome: "provider_error", ...providerErrorDetail(error) }));
        }
      }
    };

    await Promise.all([listFormalities(), runInParallel(batches, LIMITS.draftConcurrency, draftBatch)]);

    // Nothing drafted at all is a failure, not an empty document.
    if (drafted === 0 && pending.length > 0 && done.size === 0) {
      await ctx.runMutation(failRef, { ...args, failure: providerErrors > 0 ? "provider" : "timeout" });
      return null;
    }
    await ctx.runMutation(completeRef, args);
    console.info("document_draft_write", JSON.stringify({ outcome: "complete", batches: batches.length, providerErrors, elapsedMs: Date.now() - startedAt, stopped }));
    return null;
  },
});

/** Rewrites one clause against the law, following the person's instruction. */
export const revise = internalAction({
  args: { clauseId: v.id("documentDraftClauses"), revision: v.number(), instruction: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const target = { clauseId: args.clauseId, revision: args.revision };
    const input = await ctx.runQuery(revisionInputRef, target);
    if (!input) return null;
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    const search = fileSearchTool(input.research);
    if (!apiKey || !search) { await ctx.runMutation(failRevisionRef, target); return null; }
    const client: Client = new GoogleGenAI({ apiKey });
    let clause: ProposedClause | undefined;
    let pool: unknown[] = [];
    for (let attempt = 0; attempt < 2 && !clause; attempt++) {
      try {
        const response = await client.interactions.create({
          model: model(),
          input: { type: "text", text: revisePrompt(input.context, input.clause, args.instruction) },
          system_instruction: reviseInstruction(input.context.audience),
          tools: [search.tool],
          store: false,
          stream: false,
          generation_config: { max_output_tokens: 8_192 },
        } as unknown as CreateParams, { maxRetries: 0, timeout: REVISE_TIMEOUT_MS });
        const output = interactionOutput(response, search.stores);
        const parsed = output ? parseDraftOutput(output, [input.clause.ordinal]) : null;
        clause = parsed?.clauses[0];
        pool = parsed?.pool ?? [];
      } catch (error) {
        console.warn("document_draft_revise", JSON.stringify({ outcome: "provider_error", ...providerErrorDetail(error) }));
      }
    }
    if (!clause) { await ctx.runMutation(failRevisionRef, target); return null; }
    await ctx.runMutation(saveRevisionRef, { ...target, clause: clauseForStorage(clause), pool });
    return null;
  },
});
