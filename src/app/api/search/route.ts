import { NextResponse } from 'next/server'
import { Groundx } from "groundx-typescript-sdk"
import { tavily } from "@tavily/core"
import OpenAI from 'openai'

const groundx = new Groundx({
    apiKey: process.env.GROUNDX_API_KEY as string,
})

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY as string,
    baseURL: process.env.OPENAI_BASE_URL as string,
    defaultHeaders: {'Helicone-Auth': `Bearer ${process.env.HELICONE_API_KEY}`}
});

const tavilySearch = async (query: string) => {
    try {
        const tvly = tavily({
            apiKey: process.env.TAVILY_API_KEY as string
    })
    const response = await tvly.search(query, {
      maxResults: 5, 
      searchDepth: 'advanced', 
      includeAnswer: true,
    })
  
        return response.answer
    } catch (error) {
        console.error('Error:', error)
        return ""
    }
}

const ragSearch = async (query: string) => {
    const response = await groundx.search.content({
        id: 11833,
        query
    })

    const llmText: string | undefined = response.data.search.text;

    return llmText
}

const callLLM = async (systemPrompt: string, userPrompt: string, model: string, stream: boolean = false) => {
    const completion = await openai.chat.completions.create({
        model,
        messages: [
            {
                "role": "system",
                "content": systemPrompt
            },
            {"role": "user", "content": userPrompt},
        ],
        stream: stream
    });

    if (stream) {
        return completion;
    } else {
        return (completion as OpenAI.Chat.Completions.ChatCompletion).choices[0].message.content;
    }
}

// const checkIfSearchNeeded = async (context: string, query: string, model: string) => {
//     const instruction = `
//         You are an AI assistant tasked with determining if additional information from a web search is needed to answer a user's query.
        
//         Your task:
//         1. Analyze the given context and the user's query.
//         2. Determine if the context contains sufficient information to answer the query comprehensively.
//         3. If the context is sufficient, respond with "No".
//         4. If additional information is required, respond with a query to search for.
        
//         Respond ONLY with one of these two phrases. Do not provide any other text or explanation.

//         Context:
//         -------
//         ${context}
//         -------
//     `;

//     return await callLLM(instruction, query, model) as string
// }

async function getAnswer(searchNeeded: string, context: string, query: string, model: string = "llama-3.1-70b-versatile") {
    if (searchNeeded.toLowerCase().trim() !== "no" && searchNeeded.toLowerCase().trim() !== "no.") {
        const searchResults = await tavilySearch(searchNeeded)
        
        if (searchResults) {
            context += `
            
            **Web Search Results:**
            ${searchResults}
            `
        }
    }

    const instruction = `
        You are a helpful virtual assistant that answers questions using the content below. 
        Your task is to create detailed answers to the questions by combining
        your understanding of the world with the content provided below.
        Include section names and or article number references in your answer.
        Do not hallucinate the references (section names and or article numbers)

        Context:
        =======
        ${context}
        =======
    `;
    return await callLLM(instruction, query, model) as string
}

async function* getAnswerStream(searchNeeded: string, context: string, query: string, model: string = "llama-3.1-70b-versatile") {
    if (searchNeeded.toLowerCase().trim() !== "no" && searchNeeded.toLowerCase().trim() !== "no.") {
        const searchResults = await tavilySearch(searchNeeded)
        
        if (searchResults) {
            context += `
            
            **Web Search Results:**
            ${searchResults}
            `
        }
    }

    const instruction = `
        You are a helpful virtual assistant that answers questions using the content below. 
        Your task is to create detailed answers to the questions by combining
        your understanding of the world with the content provided below.
        Include section names and or article number references in your answer.
        Do not hallucinate the references (section names and or article numbers)

        Context:
        =======
        ${context}
        =======
    `;

    const stream = await openai.chat.completions.create({
        model,
        messages: [
            { "role": "system", "content": instruction },
            { "role": "user", "content": query },
        ],
        stream: true,
    });

    for await (const chunk of stream) {
        if (chunk.choices[0]?.delta?.content) {
            yield chunk.choices[0].delta.content;
        }
    }
}

// const enhanceQueryWithCountry = async (query: string, country: string, model: string): Promise<string> => {
//     const instruction = `
//         You are an AI assistant tasked with enhancing a user's query by incorporating a specific country context.
        
//         Your task:
//         1. Analyze the given query.
//         2. Incorporate the country "${country}" into the query in a natural way.
//         3. Rephrase the query to make it more specific and likely to retrieve relevant results.
//         4. The enhanced query should be a single sentence or question.
        
//         Respond ONLY with the enhanced query. Do not provide any other text or explanation.
//     `;

//     const enhancedQuery = await callLLM(instruction, query, model);
//     return enhancedQuery || query; 
// }

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url)
    const query = searchParams.get('query') as string
    const model = "llama-3.1-70b-versatile";

    try {
        const llmText: string | undefined = await ragSearch(query)

        if (!llmText) {
            return new Response("Sorry, I couldn't find any information on that topic.", {
                headers: { 'Content-Type': 'text/event-stream' },
            });
        }

        // const stream = new ReadableStream({
        //     async start(controller) {
        //         const encoder = new TextEncoder();
        //         for await (const chunk of getAnswerStream('No', llmText, query, model)) {
        //             controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
        //         }
        //         controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        //         controller.close();
        //     },
        // });

        // return new Response(stream, {
        //     headers: {
        //         'Content-Type': 'text/event-stream',
        //         'Cache-Control': 'no-cache',
        //         'Connection': 'keep-alive',
        //     },
        // });
        const answer = await getAnswer('No', llmText, query, model)
        return new Response(answer, {
            headers: { 'Content-Type': 'text/plain' },
        });
    } catch (error) {
        console.error('Error:', error)
        return new Response('An error occurred while processing your request.', { status: 500 });
    }
}
