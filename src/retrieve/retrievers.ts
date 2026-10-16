/**
 * 检索工厂 —— RetrieverFactory.assemble(Recipe) 把策略名兑换成实例，产出一个数据无关的可执行 Retriever。
 * embed 用的句柄与截维都在 Deps.embedding 里（装配层从 model 清单选定的那一行），本层不再自己兑换 embedder；
 * 它与检索旋钮 config.dimension 同出一个装配点（bootstrap 都从 EMBEDDING_DIMENSIONS 喂），所以这里不再设恒等自检 —— 那条自检此前从未可能触发。
 * 维度判定只剩 search 期一处：用 Deps.vectorDimensions（启动体检填的库中实际维度集合，三态：数组 / 空数组 / null）判混维；在发 embedding 请求**之前**判，
 *   因为 SQL 的 `WHERE e.dimension = N` 会把别的维度静默过滤成 0 命中，让「维度不符」长成「未找到相关内容」。
 *   体检没跑成（null）时同样拒绝 —— 那一刻无法排除混维，放行就等于 AC:186 明令禁止的 BM25-only 静默作答。
 * search 的次序：掐空问句 → 认维度三态 → embed → 向量路 →（有 lexical 装配位才跑）BM25 路 → Fuser 融合并按 limit 截。
 * 空库 / 全无 ready 的判定不在这里：那是 resources 面的计数，属于问答编排的下一步，Retriever 只回答「这两路各命中几条」。
 * 结果码：E_EMPTY_QUERY 空/纯空白提问 / E_DIMENSION_MISMATCH 库中混着异维向量 / E_DIMENSION_UNKNOWN 维度体检未跑成 / E_UNKNOWN_STAGE 策略名查无。
 */

export { RetrieverFactory, RetrieverError }

import { embedMany } from 'ai'

import type { Retriever, RetrievedChunk } from './contracts'
import type { VectorSearcher, LexicalSearcher, Fuser, RetrieverRecipe, RetrieverStageRegistry } from './contracts'

class RetrieverError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RetrieverError'
    this.code = code
  }
}

class RetrieverFactory {
  private readonly reg: RetrieverStageRegistry

  constructor(Registry: RetrieverStageRegistry) {
    this.reg = Registry
  }

  assemble(Recipe: RetrieverRecipe): Retriever {
    const Deps = Recipe.deps
    const vector = need(this.reg.vectorSearch(Recipe.vectorSearch, Deps), 'vectorSearch', Recipe.vectorSearch)
    const lexical = Recipe.lexicalSearch
      ? need(this.reg.lexicalSearch(Recipe.lexicalSearch, Deps), 'lexicalSearch', Recipe.lexicalSearch)
      : undefined
    const fuser = need(this.reg.fusion(Recipe.fusion, Deps), 'fusion', Recipe.fusion)

    const search = async (Query: string, Options?: { limit?: number }) => {
      const trimmed = Query.trim()
      if (!trimmed) throw new RetrieverError('E_EMPTY_QUERY', '提问不能为空')

      if (Deps.vectorDimensions === null) {
        throw new RetrieverError(
          'E_DIMENSION_UNKNOWN',
          `启动体检未能读出库中向量维度，无法确认与检索维度 ${Deps.config.dimension} 一致，拒绝作答`
        )
      }

      const foreign = Deps.vectorDimensions.filter((Dim) => Dim !== Deps.config.dimension)
      if (foreign.length > 0) {
        throw new RetrieverError(
          'E_DIMENSION_MISMATCH',
          `库中存在 ${foreign.join('/')} 维向量，与当前检索维度 ${Deps.config.dimension} 不符，拒绝作答`
        )
      }

      const { embeddings } = await embedMany({
        model: Deps.embedding.model,
        values: [trimmed],
        dimensions: Deps.embedding.dimensions,
      })
      const queryVector = embeddings[0]
      // 端口违约，不是业务状态：embedMany 保序保条数（实测），造不出「长度对但首元素缺失」的响应
      if (!queryVector) throw new Error('EmbeddingModelV4 违约：N 进 N 出未兑现')

      const vectorHits: RetrievedChunk[] = await vector.search(queryVector, Deps.config.vectorTopK)
      const lexicalHits: RetrievedChunk[] = lexical
        ? await lexical.search(trimmed, Deps.config.lexicalTopK)
        : []

      return fuser.fuse({ vector: vectorHits, lexical: lexicalHits }, Options?.limit)
    }

    return { search }
  }
}

function need<T>(Value: T | undefined, Kind: string, Name: string): T {
  if (!Value) throw new RetrieverError('E_UNKNOWN_STAGE', `未知的检索 ${Kind}: ${Name}`)
  return Value
}
