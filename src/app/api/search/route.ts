import { NextResponse } from 'next/server'
import { Groundx } from "groundx-typescript-sdk"
import OpenAI from 'openai';

export async function POST(request: Request) {
    const { query } = await request.json()

    const groundx = new Groundx({
        apiKey: process.env.GROUNDX_API_KEY as string,
    })

    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY as string,
        baseURL: process.env.OPENAI_BASE_URL as string,
        defaultHeaders: {'Helicone-Auth': `Bearer ${process.env.HELICONE_API_KEY}`}
    });

    
    const model = "llama-3.1-70b-versatile";
    const instruction = `
        You are a helpful virtual assistant that answers questions using the content below. 
        Your task is to create detailed answers to the questions by combining
        your understanding of the world with the content provided below. Do not share links.
    `

    try {
        const response = await groundx.search.content({
            id: 11833,
            query
        })

        const llmText: string | undefined = response.data.search.text;

        if (!llmText) {
            return NextResponse.json({ error: 'No text found in the response.' }, { status: 500 })
        }

        const maxLength = 16000;
        const firstPart = llmText.slice(0, maxLength);

        const completion = await openai.chat.completions.create({
            model: model,
            messages: [
                {
                    "role": "system",
                    "content": `${instruction}
                    ===
                    ${firstPart}
                    ===
                    `
                },
                {"role": "user", "content": query},
            ],
        });

        return NextResponse.json(completion.choices[0].message.content)
    } catch (error) {
        console.error('Error:', error)
        return NextResponse.json({ error: 'An error occurred while processing your request.' }, { status: 500 })
    }
}
