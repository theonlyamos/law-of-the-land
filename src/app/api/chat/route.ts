import { makeFunctionReference } from "convex/server";
import { NextResponse } from "next/server";

import { api } from "../../../../convex/_generated/api";
import { createTelemetryServiceProof, isOpaqueTelemetryToken } from "../../../../convex/lib/telemetryProof";
import {
  citationClaimIssueProofParts,
  createCitationClaimBindings,
} from "../../../../convex/lib/chatCitationClaim";
import { fetchAuthMutation, fetchAuthQuery, isAuthenticated } from "@/lib/auth-server";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { digestExactContext, MAX_GOVERNED_CONTEXT_LENGTH, parseGovernedContext } from "@/lib/research-limits";
import { createChatProvider } from "@/lib/jurisdiction-provider-adapters";

interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
}

const MAX_QUERY_LENGTH = 4_000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 16_000;
const MAX_ANSWER_LENGTH = 32_000;
const MAX_CITATIONS = 16;
const MAX_CITATION_LABEL_LENGTH = 200;
const REQUESTS_PER_MINUTE = 15;
const claimChatPhase = makeFunctionReference<"mutation">("telemetry:claimChatPhase");
const finalizeChatPhase = makeFunctionReference<"mutation">("telemetry:finalizeChatPhase");
const issueCitationClaim = makeFunctionReference<"mutation">("chats:issueCitationClaim");
const CHAT_FAILURE = "We couldn't process your request. Please try again.";

type CommonBody = {
  query: string;
  scenarioQuestion: string;
  messages: Message[];
  context: string;
  correlationToken: string;
  country?: string;
  jurisdictionId?: string;
  externalId?: string;
  assistantClientId?: string;
};

function parseCommonBody(body: unknown): CommonBody | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { query, messages, context, correlationToken, country, jurisdictionId, externalId, assistantClientId } = body as Record<string, unknown>;
  if (typeof query !== "string" || !query.trim() || query.trim().length > MAX_QUERY_LENGTH) return null;
  if (typeof context !== "string") return null;
  if (typeof correlationToken !== "string" || !isOpaqueTelemetryToken(correlationToken)) return null;
  if (!Array.isArray(messages) || messages.length > MAX_HISTORY_MESSAGES) return null;
  const history: Message[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
    const { role, content } = message as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || content.length > MAX_MESSAGE_LENGTH) return null;
    history.push({ role, content });
  }
  if (country !== undefined && (typeof country !== "string" || !/^[A-Za-z]{2}$/u.test(country.trim()))) return null;
  if (jurisdictionId !== undefined && (typeof jurisdictionId !== "string" || !jurisdictionId.trim())) return null;
  if (externalId !== undefined && (typeof externalId !== "string" || !externalId.trim() || externalId.length > 200)) return null;
  if (assistantClientId !== undefined &&
    (typeof assistantClientId !== "string" || !assistantClientId.trim() || assistantClientId.length > 200)) return null;
  return {
    query: query.trim(), scenarioQuestion: query, messages: history, context, correlationToken,
    ...(typeof country === "string" ? { country: country.trim().toUpperCase() } : {}),
    ...(typeof jurisdictionId === "string" ? { jurisdictionId: jurisdictionId.trim() } : {}),
    ...(typeof externalId === "string" ? { externalId: externalId.trim() } : {}),
    ...(typeof assistantClientId === "string" ? { assistantClientId: assistantClientId.trim() } : {}),
  };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function governedOutput(text: string | undefined, sources: ReturnType<typeof parseGovernedContext>["sources"]) {
  let parsed: unknown;
  try { parsed = JSON.parse(text ?? ""); } catch { throw new Error("CHAT_CITATION_SOURCE_INVALID"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("CHAT_CITATION_SOURCE_INVALID");
  const value = parsed as Record<string, unknown>;
  if (!exactKeys(value, ["answer", "citations"]) || typeof value.answer !== "string" || !value.answer.trim() || value.answer.length > MAX_ANSWER_LENGTH || !Array.isArray(value.citations) || value.citations.length > MAX_CITATIONS) {
    throw new Error("CHAT_CITATION_SOURCE_INVALID");
  }
  const sourceMap = new Map<string, (typeof sources)[number]>(
    sources.map((source) => [source.sourceRef, source]),
  );
  const seen = new Set<string>();
  const citations = value.citations.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("CHAT_CITATION_SOURCE_INVALID");
    const citation = raw as Record<string, unknown>;
    if (!exactKeys(citation, ["label", "sourceRef"]) || typeof citation.sourceRef !== "string" || typeof citation.label !== "string") throw new Error("CHAT_CITATION_SOURCE_INVALID");
    const label = citation.label.trim();
    const source = sourceMap.get(citation.sourceRef);
    const key = `${citation.sourceRef}\u0000${label}`;
    if (!source || !label || label.length > MAX_CITATION_LABEL_LENGTH || seen.has(key)) throw new Error("CHAT_CITATION_SOURCE_INVALID");
    seen.add(key);
    return {
      label,
      jurisdictionId: source.jurisdictionId,
      jurisdictionName: source.name,
      jurisdictionKind: source.kind,
      relation: source.relation,
    };
  });
  return { answer: value.answer.trim(), citations };
}

async function finalize(
  token: string,
  claimNonce: string,
  providerStatus: "success" | "failure",
  latencyMs: number,
) {
  await fetchAuthMutation(finalizeChatPhase, {
    token, claimNonce, providerStatus, latencyMs,
    serviceProof: await createTelemetryServiceProof(["finalize", token, claimNonce, providerStatus, latencyMs]),
  });
}

export async function POST(request: Request) {
  try {
    if (!(await isAuthenticated())) return NextResponse.json({ error: "Sign in to ask questions." }, { status: 401 });
    const limit = rateLimit(`chat:${clientKey(request)}`, REQUESTS_PER_MINUTE);
    if (!limit.ok) return NextResponse.json({ error: "You have sent several questions in a short time. Wait a minute, then try again." }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });
    const parsed = parseCommonBody(await request.json());
    if (!parsed) return NextResponse.json({ error: "That question could not be processed. Shorten it and try again." }, { status: 400 });
    const unified = await fetchAuthQuery(api.jurisdictions.isUnifiedJurisdictionsEnabled, {});
    if (unified) {
      if (!parsed.jurisdictionId || !parsed.externalId || !parsed.assistantClientId ||
        parsed.context.length > MAX_GOVERNED_CONTEXT_LENGTH) {
        return NextResponse.json({ error: "That question could not be processed. Shorten it and try again." }, { status: 400 });
      }
    } else if (!parsed.country) {
      return NextResponse.json({ error: "That question could not be processed. Shorten it and try again." }, { status: 400 });
    }
    const allowance = await fetchAuthQuery(api.usage.checkAllowance, {});
    if (!allowance.allowed) return NextResponse.json({ error: "You have reached your question limit for today. It resets tomorrow.", code: "quota" }, { status: 402 });

    const contextDigest = unified ? await digestExactContext(parsed.context) : undefined;
    let claim: { claimNonce: string };
    try {
      claim = await fetchAuthMutation(claimChatPhase, unified ? {
        token: parsed.correlationToken,
        jurisdictionId: parsed.jurisdictionId!,
        ...(parsed.country ? { legacyCountryCode: parsed.country } : {}),
        contextDigest,
        serviceProof: await createTelemetryServiceProof([
          "claim-jurisdiction-v1", parsed.correlationToken, parsed.jurisdictionId!, parsed.country ?? "", contextDigest!,
        ]),
      } : {
        token: parsed.correlationToken,
        jurisdictionCode: parsed.country!,
        serviceProof: await createTelemetryServiceProof(["claim", parsed.correlationToken, parsed.country!]),
      });
    } catch {
      return NextResponse.json({ error: "That search result has expired or was already used. Search again." }, { status: 400 });
    }

    const startedAt = performance.now();
    let result: { result: string; citations?: ReturnType<typeof governedOutput>["citations"]; citationClaim?: string };
    try {
      const chatProvider = createChatProvider(process.env);
      if (unified) {
        const governed = parseGovernedContext(parsed.context);
        const model = governedOutput(await chatProvider.generate({
          mode: "governed",
          scenarioQuestion: parsed.scenarioQuestion,
          context: parsed.context,
          query: parsed.query,
          history: parsed.messages,
        }), governed.sources);
        result = { result: model.answer, citations: model.citations };
      } else {
        const context = parsed.context.slice(0, MAX_GOVERNED_CONTEXT_LENGTH);
        const instruction = `Today's date is ${new Date().toISOString().split("T")[0]}.\n\nYou are a helpful virtual assistant that answers questions using the content below. Create detailed answers by combining your understanding of the world with the content provided below.\n\nCite the section names and/or article numbers from the context that support your answer. Do not invent references, and do not include web links — citations should point to the legal text itself.\nFormat your response in markdown.\nUse proper line breaks between paragraphs.\n\nContext:\n=======\n${context}\n=======\n\nCurrent query: ${parsed.query}`;
        result = { result: (await chatProvider.generate({
          mode: "legacy",
          scenarioQuestion: parsed.scenarioQuestion,
          instruction,
          query: parsed.query,
          history: parsed.messages,
        })) ?? "" };
      }
    } catch {
      const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      try { await finalize(parsed.correlationToken, claim.claimNonce, "failure", latencyMs); } catch { /* lease expiry fallback */ }
      console.error("Chat provider request failed");
      return NextResponse.json({ error: CHAT_FAILURE }, { status: 500 });
    }
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (unified && result.citations?.length) {
      const bindings = await createCitationClaimBindings(
        parsed.assistantClientId!,
        result.result,
        result.citations,
      );
      try {
        const issued = await fetchAuthMutation(issueCitationClaim, {
          externalId: parsed.externalId!,
          jurisdictionId: parsed.jurisdictionId!,
          assistantClientId: parsed.assistantClientId!,
          assistantContent: result.result,
          citations: result.citations,
          ...bindings,
          serviceProof: await createTelemetryServiceProof(await citationClaimIssueProofParts({
            externalId: parsed.externalId!,
            jurisdictionId: parsed.jurisdictionId!,
            ...bindings,
          })),
        }) as { citationClaim: string };
        result.citationClaim = issued.citationClaim;
      } catch {
        try { await finalize(parsed.correlationToken, claim.claimNonce, "success", latencyMs); } catch { /* lease expiry fallback */ }
        console.error("Chat citation persistence claim failed");
        return NextResponse.json({ error: CHAT_FAILURE }, { status: 500 });
      }
    }
    try {
      await finalize(parsed.correlationToken, claim.claimNonce, "success", latencyMs);
    } catch {
      console.error("Chat telemetry finalization failed");
      return NextResponse.json({ error: CHAT_FAILURE }, { status: 500 });
    }
    return NextResponse.json(result);
  } catch {
    console.error("Chat request failed");
    return NextResponse.json({ error: CHAT_FAILURE }, { status: 500 });
  }
}
