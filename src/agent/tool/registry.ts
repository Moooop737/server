import { type ToolSet, tool } from "ai"
import { RetrieverError } from "../../retrieve/retrievers";
import { z } from "zod"
export { RegistedTools }

const RegistedTools = {
    retrive: tool({
        description: "Retrive data from user's knowledge base",
        inputSchema: z.object({
            prompt : z.string().describe('search input prompt to knowledge base'),
            topK : z.number().gt(3).lt(20).describe('output knowledge rows you need'),
        }),
        execute : async ({prompt , topK }) => 
    })

} as const satisfies ToolSet 