import { Groundx } from "groundx-typescript-sdk"
import { ConvexError } from "convex/values"
import { makeFunctionReference } from "convex/server"
import { NextResponse } from "next/server"
import { api } from "../../../../convex/_generated/api"
import { fetchAuthMutation, fetchAuthQuery, isAuthenticated } from "@/lib/auth-server"
import { clientKey, rateLimit } from "@/lib/rate-limit"
import {
    createOpaqueTelemetryToken,
    createTelemetryServiceProof,
} from "../../../../convex/lib/telemetryProof"

const MAX_QUERY_LENGTH = 4000
const REQUESTS_PER_MINUTE = 15
const issueCorrelation = makeFunctionReference<"mutation">("telemetry:issueCorrelation")
const recordSearchPhase = makeFunctionReference<"mutation">("telemetry:recordSearchPhase")
const SEARCH_JURISDICTION_ENDPOINT = "/internal/search-jurisdiction"

type SearchJurisdiction = {
    enabled: true
    productionBucketId: string
} | null

async function fetchSearchJurisdiction(code: string): Promise<SearchJurisdiction> {
    const siteUrl = process.env.NEXT_PUBLIC_CONVEX_SITE_URL?.replace(/\/$/, "")
    const secret = process.env.SEARCH_JURISDICTION_SECRET
    if (!siteUrl || !secret || secret.length < 32) {
        throw new Error("Search jurisdiction transport is not configured")
    }
    const response = await fetch(`${siteUrl}${SEARCH_JURISDICTION_ENDPOINT}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-search-jurisdiction-secret": secret,
        },
        body: JSON.stringify({ code }),
    })
    if (!response.ok) throw new Error("Search jurisdiction transport failed")
    return await response.json() as SearchJurisdiction
}

export async function POST(request: Request) {
    try {
        if (!(await isAuthenticated())) {
            return NextResponse.json(
                { error: "Sign in to search the legal library." },
                { status: 401 }
            )
        }

        const limit = rateLimit(`search:${clientKey(request)}`, REQUESTS_PER_MINUTE)
        if (!limit.ok) {
            return NextResponse.json(
                { error: "You have sent several searches in a short time. Wait a minute, then try again." },
                { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
            )
        }

        const body = (await request.json()) as Record<string, unknown> | null
        const query = typeof body?.query === "string" ? body.query.trim() : ""
        if (!query || query.length > MAX_QUERY_LENGTH) {
            return NextResponse.json(
                { error: "That search could not be processed. Shorten it and try again." },
                { status: 400 }
            )
        }

        const countryWasOmitted = body?.country === undefined || body?.country === null
        const suppliedCountryCode =
            typeof body?.country === "string" ? body.country.trim().toUpperCase() : ""
        const publicJurisdictions = countryWasOmitted
            ? await fetchAuthQuery(api.jurisdictions.listPublicEnabled, {})
            : null
        const countryCode = countryWasOmitted
            ? publicJurisdictions?.find((candidate) => candidate.isDefault)?.code ??
              publicJurisdictions?.[0]?.code ??
              ""
            : suppliedCountryCode
        const jurisdiction = /^[A-Z]{2}$/.test(countryCode)
            ? await fetchSearchJurisdiction(countryCode)
            : null
        const productionBucketId = jurisdiction?.productionBucketId?.trim()
        const productionBucket =
            productionBucketId && /^\d+$/.test(productionBucketId)
                ? Number(productionBucketId)
                : Number.NaN
        if (
            jurisdiction?.enabled !== true ||
            !Number.isSafeInteger(productionBucket) ||
            productionBucket <= 0
        ) {
            return NextResponse.json(
                { error: "That country is not supported yet." },
                { status: 400 }
            )
        }

        // Count this question against the user's daily quota.
        try {
            await fetchAuthMutation(api.usage.recordQuestion, {})
        } catch (error) {
            if (error instanceof ConvexError && (error.data as { code?: string })?.code === "QUOTA_EXCEEDED") {
                const data = error.data as { limit: number; isPro: boolean }
                return NextResponse.json(
                    {
                        error: data.isPro
                            ? `You have reached today's fair-use limit of ${data.limit} questions. It resets tomorrow.`
                            : `You have used your ${data.limit} free questions for today. Upgrade to Pro for more, or come back tomorrow.`,
                        code: "quota",
                    },
                    { status: 402 }
                )
            }
            throw error
        }

        const correlationToken = createOpaqueTelemetryToken()
        await fetchAuthMutation(issueCorrelation, {
            token: correlationToken,
            jurisdictionCode: countryCode,
            serviceProof: await createTelemetryServiceProof([
                "issue",
                correlationToken,
                countryCode,
            ]),
        })

        const groundx = new Groundx({
            apiKey: process.env.GROUNDX_API_KEY as string,
        })
        const startedAt = performance.now()
        let response: Awaited<ReturnType<typeof groundx.search.content>>
        try {
            response = await groundx.search.content({
                id: productionBucket,
                query
            })
        } catch {
            const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))
            try {
                await fetchAuthMutation(recordSearchPhase, {
                    token: correlationToken,
                    providerStatus: "failure",
                    latencyMs,
                    resultCount: 0,
                    serviceProof: await createTelemetryServiceProof([
                        "search",
                        correlationToken,
                        "failure",
                        latencyMs,
                        0,
                    ]),
                })
            } catch {
                // The correlation expiry finalizer remains the terminal fallback.
            }
            console.error("Search provider request failed")
            return NextResponse.json({ error: "We couldn't find relevant legal information for your question." }, { status: 500 })
        }
        const llmText: string | undefined = response.data.search.text
        const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))
        const providerStatus = llmText ? "success" as const : "no_result" as const
        const resultCount = llmText ? 1 : 0
        await fetchAuthMutation(recordSearchPhase, {
            token: correlationToken,
            providerStatus,
            latencyMs,
            resultCount,
            serviceProof: await createTelemetryServiceProof([
                "search",
                correlationToken,
                providerStatus,
                latencyMs,
                resultCount,
            ]),
        })
        return NextResponse.json({
            result: llmText || "No relevant legal information found for your question.",
            correlationToken,
            jurisdictionCode: countryCode,
        })
    } catch (error) {
        console.error("Search request failed")
        return NextResponse.json({ error: "We couldn't find relevant legal information for your question." }, { status: 500 })
    }
}
