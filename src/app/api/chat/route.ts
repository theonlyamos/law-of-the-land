import { NextResponse } from 'next/server'
import { GoogleGenAI } from "@google/genai"

interface Message {
    id?: string
    role: 'user' | 'assistant'
    content: string
}

const callLLM = async (instruction: string, query: string, model: string = "gemini-2.0-flash", history: Message[] = []) => {
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

export async function POST(request: Request) {
    try {
        const { query, messages, context } = await request.json()

        const instruction = `Today's date is ${new Date().toISOString().split('T')[0]}.
        
        You are a helpful virtual assistant that answers questions using the content below. Your task is to create detailed answers to the questions by combining your understanding of the world with the content provided below. Do not share links

        Your task is to create detailed answers to the questions by combining
        your understanding of the world with the content provided below.
        
        Include section names and or article number references in your answer.
        Format your response in markdown.
        Use proper line breaks between paragraphs.
        Do not hallucinate the references (section names and or article numbers)
        
        Context:
        =======
        ${context}
        =======
        
        Current query: ${query}`

        const response = await callLLM(instruction, query, "gemini-2.0-flash", messages)

        return NextResponse.json({ result: response })
    } catch (error) {
        console.error('Chat error:', error)
        return NextResponse.json(
            { error: 'An error occurred while processing your request.' },
            { status: 500 }
        )
    }
} 