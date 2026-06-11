import { Groundx } from "groundx-typescript-sdk"
import { ConvexError } from "convex/values"
import { NextResponse } from "next/server"
import { api } from "@/convex/_generated/api"
import { fetchAuthMutation, isAuthenticated } from "@/lib/auth-server"
import { DEFAULT_COUNTRY, findCountry } from "@/lib/countries"
import { clientKey, rateLimit } from "@/lib/rate-limit"

const MAX_QUERY_LENGTH = 4000
const REQUESTS_PER_MINUTE = 15

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

        const country =
            body?.country === undefined || body?.country === null
                ? DEFAULT_COUNTRY
                : findCountry(typeof body.country === "string" ? body.country : null)
        if (!country) {
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

        const groundx = new Groundx({
            apiKey: process.env.GROUNDX_API_KEY as string,
        })

        const response = await groundx.search.content({
            id: country.groundxBucketId,
            query
        })

        const llmText: string | undefined = response.data.search.text;
        return NextResponse.json({ result: llmText || "No relevant legal information found for your question." })
    } catch (error) {
        console.error('Error:', error)
        return NextResponse.json({ error: "We couldn't find relevant legal information for your question." }, { status: 500 })
    }
}
