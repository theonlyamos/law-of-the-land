import { z } from "zod";
const source = z.object({ label: z.string().max(500), jurisdictionId: z.string(), jurisdictionName: z.string().max(500), jurisdictionKind: z.enum(["geographic", "organizational"]), relation: z.literal("selected"), issuer: z.string(), officialCitation: z.string(), effectiveDate: z.string().nullable(), sourceUrl: z.string().nullable() });
export const doneSchema = z.object({ requestId: z.string().uuid(), answer: z.string().max(65536), citations: z.array(source).max(16), completedAt: z.number().finite() });
export const errorSchema = z.object({ code: z.string().max(50), message: z.string().max(500), retryAfterSeconds: z.number().positive().optional() });
export const turnSchema = z.object({ requestId: z.string().uuid(), status: z.enum(["pending", "completed", "failed", "aborted"]), result: doneSchema.optional(), error: errorSchema.optional(), retryAfterSeconds: z.number().optional() });
export type Done = z.infer<typeof doneSchema>;
export async function readAnswer(response: Response, requestId: string, status: (text: string) => void): Promise<Done | null> {
  if (!response.ok) {
    const body = await response.json();
    const parsed = errorSchema.safeParse(body.error);
    throw new Error(parsed.success ? parsed.data.message : "We couldn't send this question.");
  }
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    const turn = turnSchema.parse(await response.json());
    if (turn.requestId !== requestId) throw new Error("Answer mismatch.");
    if (turn.result?.requestId === requestId && turn.status === "completed") return turn.result;
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", bytes = 0, answer: Done | null = null;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 131072) throw new Error("Answer exceeded its limit.");
      buffer += decoder.decode(next.value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const event = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (event.type === "done") {
          answer = doneSchema.parse(event);
          if (answer.requestId !== requestId) throw new Error("Answer mismatch.");
        } else if (event.type === "status" && ["generating", "validating"].includes(event.status)) {
          status(event.status === "validating" ? "Checking sources…" : "Preparing your answer…");
        } else if (event.type === "error") throw new Error(errorSchema.parse(event.error).message);
        else throw new Error("Unexpected answer format.");
      }
    }
    if (buffer.trim() || decoder.decode()) throw new Error("Answer was interrupted.");
    return answer;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export { frameMessage } from "./messages";
