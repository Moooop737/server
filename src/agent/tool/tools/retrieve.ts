/**
 * 检索工具 —— 由模型自己决定要不要检索、用什么词检索、要几条（topK）。
 * 依赖走闭包、不走 toolsContext：buildRetrieveTool(Retriever) 由 registry 在 ChatService 构造期调一次，
 *   那只 Retriever 是 RetrieverFactory 持有的默认装配（与请求无关；维度判定在 search 里每请求现查，不会被构造期凝固）。
 * execute 的错误规矩：RetrieverError 一律 catch 后 return 结构化 error（理由见 contracts.ts 文件头）；
 *   非 RetrieverError 记一行结构化日志后照旧抛，别把真 bug 洗成看起来像拒答。
 * topK 只截融合后的条数（fusion/rrf.ts 的 slice），两路候选条数固定读 config 的 retrievalVectorTopK / retrievalLexicalTopK。
 */

export { buildRetrieveTool }

import { type Tool, tool } from 'ai'
import { z } from 'zod'
import { RetrieverError } from '../../../retrieve/retrievers'

import type { RetrieveToolInput, RetrieveToolOutput, RetrievedHit } from '../contracts'
import type { Retriever, RetrievalResult, RetrievedChunk } from '../../../retrieve/contracts'

function buildRetrieveTool(Retriever: Retriever): Tool<RetrieveToolInput, RetrieveToolOutput> {
  return tool({
    description: "Search the user's knowledge base with hybrid retrieval (vector + BM25). Call it before answering anything about the user's documents.",
    inputSchema: z.object({
      prompt: z.string().describe('search input prompt to knowledge base'),
      topK: z.number().int().gt(3).lt(20).describe('output knowledge rows you need'),
    }),
    execute: async (Input: RetrieveToolInput) => {
      try {
        return toOutput(await Retriever.search(Input.prompt, { limit: Input.topK }))
      } catch (err) {
        if (err instanceof RetrieverError) {
          return { hits: [], vectorCount: 0, lexicalCount: 0, error: { code: err.code, message: err.message } }
        }
        console.error(JSON.stringify({ code: 'E_TOOL_RETRIEVE', message: String(err) }))
        throw err
      }
    },
  })
}

function toOutput(Result: RetrievalResult): RetrieveToolOutput {
  return { hits: Result.hits.map(toHit), vectorCount: Result.vectorCount, lexicalCount: Result.lexicalCount, error: null }
}

function toHit(Hit: RetrievedChunk): RetrievedHit {
  return {
    chunkId: Hit.chunk.id,
    resourceId: Hit.chunk.resource_id,
    chunkIndex: Hit.chunk.chunk_index,
    startOffset: Hit.chunk.start_offset,
    endOffset: Hit.chunk.end_offset,
    docTitle: Hit.docTitle,
    source: Hit.source,
    dataUri: Hit.dataUri,
    content: Hit.chunk.content,
    score: Hit.score,
    similarity: Hit.similarity,
    lexicalScore: Hit.lexicalScore,
  }
}
