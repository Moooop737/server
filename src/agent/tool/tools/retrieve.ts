/**
 * 检索工具 —— 由模型自己决定要不要检索、用什么词检索、要几条（topK）。
 * 依赖走闭包、不走 toolsContext：retrieve(Retriever) 由 worker 在每轮调一次，
 *   那只 Retriever 由调用方按世界传入（chat 用主库装配，评测用评测世界那份；维度判定在 search 里每请求现查）。
 * 评测可传 Options.search 覆盖两路候选/阈值/RRF；limit 是上限：模型要的 topK 超过它时被截到上限。
 * execute 的错误规矩：RetrieverError 一律 catch 后 return 结构化 error（理由见 contracts.ts 文件头）；
 *   非 RetrieverError 记一行结构化日志后照旧抛，别把真 bug 洗成看起来像拒答。
 */

export { buildRetrieveTool, retrieve }

import { type Tool, tool } from 'ai'
import { z } from 'zod'
import { RetrieverError } from '../../../retrieve/retrievers'
import { getLlmtraceBridge } from '../../../trace/llmtrace/bridge'
import { logError } from '../../../trace/systemtrace/log'

import type { AgentToolEntry } from '../weave'
import type { RetrieveToolInput, RetrieveToolOptions, RetrieveToolOutput, RetrievedHit } from '../contracts'
import type { Retriever, RetrievalResult, RetrievedChunk, SearchOptions } from '../../../retrieve/contracts'

function retrieve(Retriever: Retriever, Options: RetrieveToolOptions = {}): AgentToolEntry {
  return {
    name: 'retrieve',
    catalog: "hybrid search over the user's knowledge base",
    instruction: "Call retrieve before answering anything about the user's documents. If retrieve returns hits, answer from them. If it returns no hits, say the knowledge base has no answer.",
    tool: buildRetrieveTool(Retriever, Options),
  }
}

function buildRetrieveTool(Retriever: Retriever, Options: RetrieveToolOptions = {}): Tool<RetrieveToolInput, RetrieveToolOutput> {
  return tool({
    description: "Search the user's knowledge base with hybrid retrieval (vector + BM25). Call it before answering anything about the user's documents.",
    inputSchema: z.object({
      prompt: z.string().describe('search input prompt to knowledge base'),
      topK: z.number().int().gt(3).lt(20).describe('output knowledge rows you need'),
    }),
    execute: async (Input: RetrieveToolInput) => {
      try {
        const Sink = Options.trace === false ? undefined : getLlmtraceBridge()?.createStageSink() ?? undefined
        const Limit = Options.search?.limit === undefined ? Input.topK : Math.min(Input.topK, Options.search.limit)
        const Search: SearchOptions = { ...Options.search, limit: Limit, ...(Sink === undefined ? {} : { sink: Sink }) }
        return toOutput(await Retriever.search(Input.prompt, Search))
      } catch (err) {
        if (err instanceof RetrieverError) {
          return { hits: [], vectorCount: 0, lexicalCount: 0, error: { code: err.code, message: err.message } }
        }
        logError('E_TOOL_RETRIEVE', String(err))
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
