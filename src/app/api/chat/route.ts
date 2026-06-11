import { NextResponse } from 'next/server'
import { GoogleGenAI } from "@google/genai"
import { api } from '@/convex/_generated/api'
import { fetchAuthQuery, isAuthenticated } from '@/lib/auth-server'
import { clientKey, rateLimit } from '@/lib/rate-limit'

interface Message {
    id?: string
    role: 'user' | 'assistant'
    content: string
}

const MAX_QUERY_LENGTH = 4000
const MAX_HISTORY_MESSAGES = 20
const MAX_MESSAGE_LENGTH = 16000
// Search context is our own /api/search output round-tripped through the
// client — oversized values are truncated, not rejected.
const MAX_CONTEXT_LENGTH = 120000
const REQUESTS_PER_MINUTE = 15

const callLLM = async (instruction: string, query: string, model: string = "gemini-3.1-flash-lite-preview", history: Message[] = []) => {
    try {
        const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY as string });
        const generationConfig = {
            temperature: 0.2,
            maxOutputTokens: 8192,
            responseMimeType: "text/plain",
            systemInstruction: instruction,
            tools: [{
                googleSearch: {}
            }]
        };

        const chat = ai.chats.create({
            model,
            config: generationConfig,
            history: history.map((message) => ({
                role: message.role === "user" ? "user" : "model",
                parts: [{ text: message.content }]
            })),
        })

        const response = await chat.sendMessage({
            message: query
        })

        return response.text;
    } catch (error) {
        console.error('Error calling LLM:', error);
        throw error;
    }
}

function parseBody(body: unknown): { query: string; messages: Message[]; context: string } | null {
    if (typeof body !== 'object' || body === null) return null
    const { query, messages, context } = body as Record<string, unknown>

    if (typeof query !== 'string') return null
    const trimmedQuery = query.trim()
    if (!trimmedQuery || trimmedQuery.length > MAX_QUERY_LENGTH) return null

    if (typeof context !== 'string') return null

    if (!Array.isArray(messages) || messages.length > MAX_HISTORY_MESSAGES) return null
    const history: Message[] = []
    for (const message of messages) {
        if (typeof message !== 'object' || message === null) return null
        const { role, content } = message as Record<string, unknown>
        if (role !== 'user' && role !== 'assistant') return null
        if (typeof content !== 'string' || content.length > MAX_MESSAGE_LENGTH) return null
        history.push({ role, content })
    }

    return { query: trimmedQuery, messages: history, context: context.slice(0, MAX_CONTEXT_LENGTH) }
}

export async function POST(request: Request) {
    try {
        if (!(await isAuthenticated())) {
            return NextResponse.json(
                { error: 'Sign in to ask questions.' },
                { status: 401 }
            )
        }

        const limit = rateLimit(`chat:${clientKey(request)}`, REQUESTS_PER_MINUTE)
        if (!limit.ok) {
            return NextResponse.json(
                { error: 'You have sent several questions in a short time. Wait a minute, then try again.' },
                { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
            )
        }

        // The search endpoint already counted this question; verify allowance only.
        const allowance = await fetchAuthQuery(api.usage.checkAllowance, {})
        if (!allowance.allowed) {
            return NextResponse.json(
                { error: 'You have reached your question limit for today. It resets tomorrow.', code: 'quota' },
                { status: 402 }
            )
        }

        const parsed = parseBody(await request.json())
        if (!parsed) {
            return NextResponse.json(
                { error: 'That question could not be processed. Shorten it and try again.' },
                { status: 400 }
            )
        }
        const { query, messages, context } = parsed

        const instruction = `Today's date is ${new Date().toISOString().split('T')[0]}.

        You are a helpful virtual assistant that answers questions using the content below. Create detailed answers by combining your understanding of the world with the content provided below.

        Cite the section names and/or article numbers from the context that support your answer. Do not invent references, and do not include web links — citations should point to the legal text itself.
        Format your response in markdown.
        Use proper line breaks between paragraphs.

        Context:
        =======
        ${context}
        =======

        Current query: ${query}`

        const response = await callLLM(instruction, query, "gemini-3.1-flash-lite-preview", messages)

        return NextResponse.json({ result: response })
    } catch (error) {
        console.error('Chat error:', error)
        return NextResponse.json(
            { error: 'We couldn\'t process your request. Please try again.' },
            { status: 500 }
        )
    }
}
