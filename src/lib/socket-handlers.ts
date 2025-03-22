import { Socket } from 'socket.io'
import { Groundx } from "groundx-typescript-sdk"
import { GenerateContentConfig, GoogleGenAI } from "@google/genai"
// import { tavily } from "@tavily/core"

interface Message {
    id?: string
    role: 'user' | 'assistant'
    content: string
}

// const tavilySearch = async (query: string) => {
//     try {
//         const tvly = tavily({
//             apiKey: process.env.TAVILY_API_KEY as string
//         })
//         const response = await tvly.search(query, {
//             maxResults: 5,
//             searchDepth: 'advanced',
//             includeAnswer: true,
//         })

//         return response.answer
//     } catch (error) {
//         console.error('Error:', error)
//         return ""
//     }
// }

const callLLM = async (instruction: string, query: string, model: string = "gemini-2.0-flash", history: Message[] = []) => {
    try {
        const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY as string });
        const generationConfig: GenerateContentConfig = {
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
        return "";
    }
}

// const checkIfSearchNeeded = async (context: string, query: string, model: string) => {
//     const instruction = `
//         You are an AI assistant tasked with determining if additional information from a web search is needed to answer a user's query.
//         You have outdated information, so you need to search the web for the most recent information.

//         Today's date is ${new Date().toISOString().split('T')[0]}.

//         Your task:
//         1. Analyze the given context and the user's query.
//         2. Determine if the context contains sufficient information to answer the query comprehensively.
//         3. If the context is sufficient, respond with "No".
//         4. If additional information is required, respond with a query to search for.
//         5. Do not use your own knowledge generate the query.
//         6. Never answer the query, only generate the query to search for.

//         Respond ONLY with one of these two phrases. Do not provide any other text or explanation.

//         Context:
//         -------
//         ${context}
//         -------
//     `;

//     return await callLLM(instruction, query, model) as string
// }

// const enhanceQuery = async (query: string, model: string): Promise<string> => {
//     const instruction = `
//         You are an AI assistant tasked with enhancing a user's query.

//         Your task:
//         1. Analyze the given query.
//         3. Rephrase the query to make it more specific and likely to retrieve relevant results.
//         4. The enhanced query should be a single sentence or question.
//         5. Do not use your own knowledge, only use the context provided.

//         Respond ONLY with the enhanced query. Do not provide any other text or explanation.
//     `;

//     const enhancedQuery = await callLLM(instruction, query, model);
//     return enhancedQuery || query;
// }

const ragSearch = async (query: string): Promise<string> => {
    try {
        const groundx = new Groundx({
            apiKey: process.env.GROUNDX_API_KEY as string,
        })
        const response = await groundx.search.content({
            id: 11833,
            query
        })

        const llmText: string | undefined = response.data.search.text;

        return llmText || "No relevant context found for query"
    } catch (error) {
        console.error('Error:', error)
        return "No relevant context found for query"
    }
}

export const handleSearchRequest = async (socket: Socket, data: { query: string, messages: Message[] }) => {
    try {
        const { query, messages } = data

        // Get initial context from RAG search
        const ragContext = await ragSearch(query)

        // if (!ragContext) {
        //     throw new Error("No relevant context found")
        // }

        // Check if additional search is needed
        // const needsAdditionalSearch = await checkIfSearchNeeded(ragContext, query, "gemini-2.0-flash")
        // console.log('needsAdditionalSearch', needsAdditionalSearch)
        // let finalContext = ragContext
        // if (needsAdditionalSearch.trim() !== "No") {
        //     // Enhance the search query with country context
        //     // const enhancedQuery = await enhanceQuery(needsAdditionalSearch, "gemini-1.5-flash-002")

        //     // Get additional context from Tavily
        //     const tavilyContext = await tavilySearch(needsAdditionalSearch)
        //     console.log('tavilyContext', tavilyContext)
        //     if (tavilyContext) {
        //         finalContext = `${ragContext}\n\nAdditional Context:\n${tavilyContext}`
        //     }
        // }


        // Create the instruction for the LLM
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
        ${ragContext}
        =======
        
        Current query: ${query}`

        // Generate the response using the existing callLLM function
        const response = await callLLM(instruction, query, "gemini-2.0-flash", messages)

        // Emit the search results
        socket.emit('search:complete', { result: response })
    } catch (error) {
        console.error('Search error:', error)
        socket.emit('search:error', { error: 'An error occurred while processing your request.' })
    }
} 