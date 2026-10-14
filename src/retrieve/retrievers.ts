/**
 * 检索工厂 —— RetrieverFactory.assemble(Recipe) 把策略名兑换成实例，产出一个数据无关的可执行 Retriever。
 * NFR-6 的维度判定分两处，各管一件事：
 * · 装配期自检 embedder.dimensions 与 config.dimension —— 只抓注册表被塞进第二个 embedder / 两者来自不同 env 这类装配错误，
 *   恒等的两边同出一个 config，它**看不见**库里混维。
 * · search 期用 Deps.vectorDimensions（启动体检填的库中实际维度集合，三态：数组 / 空数组 / null）判混维；在发 embedding 请求**之前**判，
 *   因为 SQL 的 `WHERE e.dimension = N` 会把别的维度静默过滤成 0 命中，让「维度不符」长成「未找到相关内容」。
 *   体检没跑成（null）时同样拒绝 —— 那一刻无法排除混维，放行就等于 AC:186 明令禁止的 BM25-only 静默作答。
 * search 的次序：掐空问句 → 认维度三态 → embed → 向量路 →（有 lexical 装配位才跑）BM25 路 → Fuser 融合并按 limit 截。
 * 空库 / 全无 ready 的判定不在这里：那是 resources 面的计数，属于问答编排的下一步，Retriever 只回答「这两路各命中几条」。
 * 结果码：E_EMPTY_QUERY 空/纯空白提问 / E_DIMENSION_MISMATCH 库中混着异维向量 / E_DIMENSION_UNKNOWN 维度体检未跑成 / E_UNKNOWN_STAGE 策略名查无。
 */

export { RetrieverFactory, RetrieverError }

import type { Embedder } from '../ports/embedder'
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
    const embedder = need(this.reg.embedder(Recipe.embedder, Deps), 'embedder', Recipe.embedder)
    const vector = need(this.reg.vectorSearch(Recipe.vectorSearch, Deps), 'vectorSearch', Recipe.vectorSearch)
    const lexical = Recipe.lexicalSearch
      ? need(this.reg.lexicalSearch(Recipe.lexicalSearch, Deps), 'lexicalSearch', Recipe.lexicalSearch)
      : undefined
    const fuser = need(this.reg.fusion(Recipe.fusion, Deps), 'fusion', Recipe.fusion)

    // 恒等式，今天不可能触发：embedder.dimensions 就是 config.dimension 喂出来的。它守的是装配错误（注册表多出第二个 embedder），不是 AC:186 那条数据事实
    if (embedder.dimensions !== Deps.config.dimension) {
      throw new RetrieverError(
        'E_DIMENSION_MISMATCH',
        `装配不一致：检索配置 ${Deps.config.dimension} 维，注册表兑换出的 embedder 输出 ${embedder.dimensions} 维`
      )
    }

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

      const vectors = await embedder.embed([trimmed])
      const queryVector = vectors[0]
      // 端口违约，不是业务状态：QwenEmbedder 自己已校验 N 进 N 出，实测也造不出「长度对但首元素缺失」的响应
      if (!queryVector) throw new Error('Embedder 违约：N 进 N 出未兑现')

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
