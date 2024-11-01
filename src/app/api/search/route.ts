// import { NextResponse } from 'next/server'
import { Groundx } from "groundx-typescript-sdk"
// import { tavily } from "@tavily/core"
import { GoogleGenerativeAI } from "@google/generative-ai"

const groundx = new Groundx({
    apiKey: process.env.GROUNDX_API_KEY as string,
})

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY as string);

// const tavilySearch = async (query: string) => {
//     try {
//         const tvly = tavily({
//             apiKey: process.env.TAVILY_API_KEY as string
//     })
//     const response = await tvly.search(query, {
//       maxResults: 5, 
//       searchDepth: 'advanced', 
//       includeAnswer: true,
//     })
  
//         return response.answer
//     } catch (error) {
//         console.error('Error:', error)
//         return ""
//     }
// }

const ragSearch = async (query: string) => {
    const response = await groundx.search.content({
        id: 11833,
        query
    })

    const llmText: string | undefined = response.data.search.text;

    return llmText
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

    try {
        const startTime = Date.now();
        const llmText: string | undefined = await ragSearch(query);
        const duration = (Date.now() - startTime) / 1000;
        console.log(`RAG search took ${duration.toFixed(2)}s`);

        if (!llmText) {
            return new Response("Sorry, I couldn't find any information on that topic.", {
                headers: { 'Content-Type': 'text/event-stream' },
            });
        }

        const stream = new ReadableStream({
            async start(controller) {
                const encoder = new TextEncoder();
                
                try {
                    const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-002" });
                    const instruction = `
                        You are a helpful virtual assistant that answers questions using the content below. 
                        Your task is to create detailed answers to the questions by combining
                        your understanding of the world with the content provided below.
                        Include section names and or article number references in your answer.
                        Format your response in markdown.
                        Use proper line breaks between paragraphs.
                        Do not hallucinate the references (section names and or article numbers)

                        Context:
                        =======
                        ${llmText}
                        =======
                    `;
                    
                    const prompt = `${instruction}\n\nUser: ${query}`;
                    const startGenTime = Date.now();
                    const result = await geminiModel.generateContentStream(prompt);
                    const genDuration = (Date.now() - startGenTime) / 1000;
                    console.log(`Generation took ${genDuration.toFixed(2)}s`);
                    
                    for await (const chunk of result.stream) {
                        if (chunk?.text()) {
                            try {
                                const formattedText = chunk.text().replace(/\n/g, '\\n');
                                controller.enqueue(encoder.encode(`data: ${formattedText}\n\n`));
                            } catch (err) {
                                console.error('Error processing chunk:', err);
                            }
                        }
                    }
                    
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                } catch (error) {
                    console.error('Streaming error:', error);
                    controller.enqueue(encoder.encode(`data: Error generating response\n\n`));
                } finally {
                    controller.close();
                }
            },
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            },
        });
    } catch (error) {
        console.error('Error:', error)
        return new Response('An error occurred while processing your request.', { status: 500 });
    }
}
