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

const callLLM = async (systemPrompt: string, userPrompt: string, model: string = "llama-3.1-70b-versatile") => {
    const completion = await openai.chat.completions.create({
        model,
        messages: [
            {
                "role": "system",
                "content": systemPrompt
            },
            {"role": "user", "content": userPrompt},
        ],
    });

    return completion.choices[0].message.content
}

const checkIfSearchNeeded = async (context: string, query: string, model: string = "llama-3.1-70b-versatile") => {
    const instruction = `
        You are an AI assistant tasked with determining if additional information from a web search is needed to answer a user's query.
        
        Your task:
        1. Analyze the given context and the user's query.
        2. Determine if the context contains sufficient information to answer the query comprehensively.
        3. If the context is sufficient, respond with "No".
        4. If additional information is required, respond with a query to search for.
        
        Respond ONLY with one of these two phrases. Do not provide any other text or explanation.

        Context:
        -------
        ${context}
        -------
    `;

    return await callLLM(instruction, query, model) as string
}

const getAnswer = async (searchNeeded: string, context: string, query: string, model: string = "llama-3.1-70b-versatile") => {
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

    return await callLLM(instruction, query, model)
}

const enhanceQueryWithCountry = async (query: string, country: string, model: string = "llama-3.1-70b-versatile"): Promise<string> => {
    const instruction = `
        You are an AI assistant tasked with enhancing a user's query by incorporating a specific country context.
        
        Your task:
        1. Analyze the given query.
        2. Incorporate the country "${country}" into the query in a natural way.
        3. Rephrase the query to make it more specific and likely to retrieve relevant results.
        4. The enhanced query should be a single sentence or question.
        
        Original query: ${query}
        
        Respond ONLY with the enhanced query. Do not provide any other text or explanation.
    `;

    const enhancedQuery = await callLLM(instruction, query, model);
    return enhancedQuery || query; 
}

export async function POST(request: Request) {
    const { query } = await request.json()
    const model = "llama-3.1-70b-versatile";
    const country = "Ghana"; // TODO: Make this dynamic based on user's location

    try {
        const enhancedQuery = await enhanceQueryWithCountry(query, country);
        
        let llmText: string | undefined = await ragSearch(enhancedQuery)

        if (!llmText) {
            return NextResponse.json("Sorry, I couldn't find any information on that topic.")
        }

        const maxLength = 16000;
        llmText = llmText.slice(0, maxLength);

        const searchNeeded = await checkIfSearchNeeded(llmText, query, model)
        
        const answer = await getAnswer(searchNeeded, llmText, query, model)
        
        return NextResponse.json(answer)
    } catch (error) {
        console.error('Error:', error)
        return NextResponse.json({ error: 'An error occurred while processing your request.' }, { status: 500 })
    }
}
