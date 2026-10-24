/**
 * 检索工厂 —— RetrieverFactory.assemble(Recipe) 把策略名兑换成实例，产出一个数据无关的可执行 Retriever。
 * embed 用的句柄与截维都在 Deps.embedding 里（装配层从 model 清单选定的那一行），本层不再自己兑换 embedder；
 * 它与检索旋钮 config.embeddingDimensions 是同一个 env 位（都读 EMBEDDING_DIMENSIONS），所以这里不再设恒等自检。
 * 维度判定只剩 search 期一处，且**每请求现查一次** repo.dimensionsInStore()，不在启动时缓存。
 * search 的次序：掐空问句 → dimension_check → embed_query → vector_recall →（有 lexical 装配位才跑）bm25_recall → rrf_fusion。
 * 每个实际执行的 stage 交给 caller 传入的 StageSink，顺序与形状集中在下面；factory 不替调用方选落点：
 *   /retrieve 传 DB sink（本地 trace_stages、embed telemetry off）；chat tool 传 Langfuse sink（tool span 下的 child spans、telemetry on）。
 *   没有 sink 时走 no-op，embed telemetry 也显式关掉，避免全局 Langfuse integration 顺手记走。
 * 空库 / 全无 ready 的判定不在这里：那是 resources 面的计数，属于问答编排的下一步，Retriever 只回答「这两路各命中几条」。
 * 结果码：E_EMPTY_QUERY 空/纯空白提问 / E_DIMENSION_MISMATCH 库中混着异维向量 / E_UNKNOWN_STAGE 策略名查无。
 * RetrieverHandle 住在 adapter/contract.ts（与 ChatHandle / EmbeddingHandle 同族，门统一交句柄），是 assemble 的唯一调用者：
 *   它在构造期用常量 Recipe（RETRIEVER_RECIPE_NAMES）加三个单例兑换一只 Retriever 并持有，路由与工具都注入它，不再各自拼 Recipe。
 *   持有同一只是安全的：维度判定在 search 里每请求现查，不在构造期凝固。
 * assemble 保持 public 只因为 private 跨类不可见，不是对外的装配入口。
 */

export { RetrieverFactory, RetrieverError }

import 'reflect-metadata'
import { createHash } from 'node:crypto'
import { embedMany } from 'ai'
import { singleton } from 'tsyringe'
import { createRetrieverStageRegistry } from './recipes'
import { NoopStageSink, runStage } from '../trace/systemtrace/stage'

import type { Retriever, RetrievalResult, SearchOptions } from './contracts'
import type { RetrieverRecipe, RetrieverStageRegistry } from './contracts'

class RetrieverError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RetrieverError'
    this.code = code
  }
}

@singleton()
class RetrieverFactory {
  private readonly reg: RetrieverStageRegistry

  constructor() {
    this.reg = createRetrieverStageRegistry()
  }

  assemble(Recipe: RetrieverRecipe): Retriever {
    const Deps = Recipe.deps
    const vector = need(this.reg.vectorSearch(Recipe.vectorSearch, Deps), 'vectorSearch', Recipe.vectorSearch)
    const lexical = Recipe.lexicalSearch
      ? need(this.reg.lexicalSearch(Recipe.lexicalSearch, Deps), 'lexicalSearch', Recipe.lexicalSearch)
      : undefined
    const fuser = need(this.reg.fusion(Recipe.fusion, Deps), 'fusion', Recipe.fusion)

    const search = async (Query: string, Options?: SearchOptions): Promise<RetrievalResult> => {
      const trimmed = Query.trim()
      if (!trimmed) throw new RetrieverError('E_EMPTY_QUERY', '提问不能为空')
      const Sink = Options?.sink ?? NoopStageSink

      const stored = await Deps.repo.dimensionsInStore()
      const foreign = stored.filter((Dim) => Dim !== Deps.config.embeddingDimensions)
      await runStage(
        Sink,
        'dimension_check',
        { expected_dimension: Deps.config.embeddingDimensions, stored_dimensions: stored },
        async () => {
          if (foreign.length > 0) {
            throw new RetrieverError(
              'E_DIMENSION_MISMATCH',
              `库中存在 ${foreign.join('/')} 维向量，与当前检索维度 ${Deps.config.embeddingDimensions} 不符，拒绝作答`,
            )
          }
          return { foreign_dimensions: [] as number[] }
        },
        (Output) => Output,
      )

      const queryVector = await runStage(
        Sink,
        'embed_query',
        { query: trimmed, model_id: Deps.embedding.modelId, dimensions: Deps.embedding.dimensions },
        async () => {
          const { embeddings } = await embedMany({
            model: Deps.embedding.model,
            values: [trimmed],
            dimensions: Deps.embedding.dimensions,
            ...(Sink.embedTelemetry === 'off' ? { telemetry: { isEnabled: false } } : {}),
          })
          const First = embeddings[0]
          // 端口违约，不是业务状态：embedMany 保序保条数（实测），造不出「长度对但首元素缺失」的响应
          if (!First) throw new Error('EmbeddingModelV4 违约：N 进 N 出未兑现')
          return First
        },
        (Vector) => ({ dimension: Vector.length, vector_hash: hashVector(Vector) }),
      )
      const vectorHash = hashVector(queryVector)

      const vectorHits = await runStage(
        Sink,
        'vector_recall',
        {
          vector_hash: vectorHash,
          top_k: Deps.config.retrievalVectorTopK,
          min_similarity: Deps.config.retrievalMinSimilarity,
          dimension: queryVector.length,
        },
        () => vector.search(queryVector, Deps.config.retrievalVectorTopK),
        (Hits) => ({
          candidates: Hits.map((Hit, Index) => ({ chunk_id: Hit.chunk.id, similarity: Hit.similarity, rank: Index + 1 })),
        }),
      )

      const lexicalHits = lexical
        ? await runStage(
          Sink,
          'bm25_recall',
          { query: trimmed, top_k: Deps.config.retrievalLexicalTopK },
          () => lexical.search(trimmed, Deps.config.retrievalLexicalTopK),
          (Hits) => ({
            candidates: Hits.map((Hit, Index) => ({ chunk_id: Hit.chunk.id, lexical_score: Hit.lexicalScore, rank: Index + 1 })),
          }),
        )
        : []

      return runStage(
        Sink,
        'rrf_fusion',
        {
          vector: vectorHits.map((Hit, Index) => ({ chunk_id: Hit.chunk.id, rank: Index + 1 })),
          lexical: lexicalHits.map((Hit, Index) => ({ chunk_id: Hit.chunk.id, rank: Index + 1 })),
          k: Deps.config.retrievalRrfK,
        },
        async () => fuser.fuse({ vector: vectorHits, lexical: lexicalHits }, Options?.limit),
        (Result) => ({
          hits: Result.hits.map((Hit) => ({ chunk_id: Hit.chunk.id, rrf_score: Hit.score })),
          vector_count: Result.vectorCount,
          lexical_count: Result.lexicalCount,
        }),
      )
    }

    return { search }
  }
}

function hashVector(Vector: number[]): string {
  return createHash('sha256').update(JSON.stringify(Vector)).digest('hex').slice(0, 16)
}

function need<T>(Value: T | undefined, Kind: string, Name: string): T {
  if (!Value) throw new RetrieverError('E_UNKNOWN_STAGE', `未知的检索 ${Kind}: ${Name}`)
  return Value
}
