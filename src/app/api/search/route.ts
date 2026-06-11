import { Groundx } from "groundx-typescript-sdk"
import { NextResponse } from "next/server"
import { isAuthenticated } from "@/lib/auth-server"
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

        const groundx = new Groundx({
            apiKey: process.env.GROUNDX_API_KEY as string,
        })

        const response = await groundx.search.content({
            id: 11833,
            query
        })

        const llmText: string | undefined = response.data.search.text;
        return NextResponse.json({ result: llmText || "No relevant legal information found for your question." })
    } catch (error) {
        console.error('Error:', error)
        return NextResponse.json({ error: "We couldn't find relevant legal information for your question." }, { status: 500 })
    }
}
