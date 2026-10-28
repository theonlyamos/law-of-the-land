import { GoogleGenAI } from "@google/genai";

import { getToken } from "@/lib/auth-server";
import { ChatAttachmentError, readAttachmentBody } from "@/lib/chat-attachment-server";
import { applicationOrigin } from "@/lib/embed/server";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { cleanTranscript, DEFAULT_TRANSCRIBE_MODEL, geminiAudioType, MAX_RECORDING_BYTES } from "@/lib/voice-transcription";

export const runtime = "nodejs";
export const maxDuration = 60;

const REQUESTS_PER_MINUTE = 12;

export async function POST(request: Request): Promise<Response> {
  const headers = { "cache-control": "no-store, private" };
  const fail = (error: string, status: number) => Response.json({ error }, { status, headers });
  try {
    if (request.headers.get("origin") !== applicationOrigin(request)) return fail("Record from your chat.", 403);
    if (!(await getToken())) return fail("Sign in to use voice input.", 401);
    const limit = rateLimit(`transcribe:${clientKey(request)}`, REQUESTS_PER_MINUTE);
    if (!limit.ok) return fail("You're recording quickly. Wait a moment and try again.", 429);
    const mimeType = geminiAudioType(request.headers.get("content-type"));
    if (!mimeType) return fail("This browser recorded audio in a format we can't read.", 415);
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) return fail("Voice input is unavailable right now.", 503);

    const bytes = await readAttachmentBody(request, MAX_RECORDING_BYTES, AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]));
    if (bytes.byteLength === 0) return fail("No audio was recorded. Try again.", 400);

    const client = new GoogleGenAI({ apiKey });
    const interaction = await client.interactions.create({
      model: process.env.GEMINI_TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL,
      input: [{ type: "audio", data: Buffer.from(bytes).toString("base64"), mime_type: mimeType }],
      // Smart mode drops filler words and fixes punctuation, which suits typed questions.
      generation_config: { transcription_config: { mode: "smart" } },
      store: false,
    }, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]) });

    const text = cleanTranscript(interaction.output_text);
    if (!text) return fail("We couldn't make out any speech. Try again a little closer to the microphone.", 422);
    return Response.json({ text }, { headers });
  } catch (error) {
    if (error instanceof ChatAttachmentError) {
      return fail(error.status === 413 ? "That recording is too long. Keep it under two minutes." : "The recording didn't upload. Try again.", error.status);
    }
    console.error("[transcribe] failed", error instanceof Error ? error.message : error);
    return fail("We couldn't transcribe that recording. Try again, or type your question.", 502);
  }
}
