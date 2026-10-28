"use node";

import { GoogleGenAI } from "@google/genai";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import {
  PROFILE_EXTRACTION_INSTRUCTION,
  PROFILE_EXTRACTION_SCHEMA,
  interactionText,
  parseProfileExtraction,
  profileExtractionPrompt,
} from "./lib/profileMemoryExtraction";

const DEFAULT_MODEL = "gemini-3.8-flash";
const TIMEOUT_MS = 30_000;

/**
 * Reads one saved question and records any profile facts it supports. Runs
 * after the answer is saved, so it never slows a reply. Failures are dropped:
 * a missed observation is always the safe outcome.
 */
export const extract = internalAction({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const input = await ctx.runQuery(internal.profileMemory.extractionInput, { messageId: args.messageId });
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!input || !apiKey) return null;
    let text: string | null = null;
    try {
      const client = new GoogleGenAI({ apiKey });
      const response = await client.interactions.create({
        model: process.env.PROFILE_MEMORY_MODEL?.trim() || DEFAULT_MODEL,
        input: profileExtractionPrompt(input.question),
        system_instruction: PROFILE_EXTRACTION_INSTRUCTION,
        tools: [],
        store: false,
        stream: false,
        generation_config: { thinking_level: "low", thinking_summaries: "none", tool_choice: "none", max_output_tokens: 2_048 },
        response_format: { type: "text", mime_type: "application/json", schema: PROFILE_EXTRACTION_SCHEMA },
      } as Parameters<typeof client.interactions.create>[0], { maxRetries: 1, timeout: TIMEOUT_MS });
      text = interactionText(response);
    } catch {
      console.warn("profile_memory_extract", JSON.stringify({ outcome: "provider_error" }));
      return null;
    }
    const observations = text ? parseProfileExtraction(text, input.question) : [];
    if (observations.length) {
      await ctx.runMutation(internal.profileMemory.recordObservations, { messageId: args.messageId, observations });
    }
    console.info("profile_memory_extract", JSON.stringify({ outcome: text ? "ok" : "invalid_response", observations: observations.length }));
    return null;
  },
});
