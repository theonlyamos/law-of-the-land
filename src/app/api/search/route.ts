import { Groundx } from "groundx-typescript-sdk"
import { NextResponse } from "next/server"

export async function POST(request: Request) {
    try {
        const { query } = await request.json()

        const groundx = new Groundx({
            apiKey: process.env.GROUNDX_API_KEY as string,
        })

        const response = await groundx.search.content({
            id: 11833,
            query
        })

        const llmText: string | undefined = response.data.search.text;
        return NextResponse.json({ result: llmText || "No relevant context found for query" })
    } catch (error) {
        console.error('Error:', error)
        return NextResponse.json({ error: "No relevant context found for query" }, { status: 500 })
    }
} 