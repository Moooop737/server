/**
 * 检索工厂 —— RetrieverFactory.assemble(Recipe) 把策略名兑换成实例，产出一个数据无关的可执行 Retriever。
 * embed 用的句柄与截维都在 Deps.embedding 里（装配层从 model 清单选定的那一行），本层不再自己兑换 embedder；
 * 它与检索旋钮 config.embeddingDimensions 是同一个 env 位（都读 EMBEDDING_DIMENSIONS），所以这里不再设恒等自检 —— 那条自检此前从未可能触发。
 * 维度判定只剩 search 期一处，且**每请求现查一次** repo.dimensionsInStore()，不在启动时缓存：现查看得见入库中途出现的新维度，也不会把一次体检失败凝固成整个进程的错误状态。
 *   必须在发 embedding 请求**之前**判 —— SQL 的 `WHERE e.dimension = N` 会把别的维度静默过滤成 0 命中，让「维度不符」长成「未找到相关内容」（AC:186 明令禁止 BM25-only 静默作答）。
 *   库里一条向量都没有（[]）不算冲突，放行；库不可达就当场抛，由调用方映射成 500 —— 原来的第三态 null 随启动体检一起没了。
 *   代价是一次到库的往返：实测 50 行的表现查 56ms（dimension 列上没有索引，表大了要再加扫描）。
 * search 的次序：掐空问句 → 现查维度并判混维 → embed → 向量路 →（有 lexical 装配位才跑）BM25 路 → Fuser 融合并按 limit 截。
 * 空库 / 全无 ready 的判定不在这里：那是 resources 面的计数，属于问答编排的下一步，Retriever 只回答「这两路各命中几条」。
 * 结果码：E_EMPTY_QUERY 空/纯空白提问 / E_DIMENSION_MISMATCH 库中混着异维向量 / E_UNKNOWN_STAGE 策略名查无。
 * RetrieverHandle 住在 adapter/contract.ts（与 ChatHandle / EmbeddingHandle 同族，门统一交句柄），是 assemble 的唯一调用者：
 *   它在构造期用常量 Recipe（RETRIEVER_RECIPE_NAMES）加三个单例兑换一只 Retriever 并持有，路由与工具都注入它，不再各自拼 Recipe。
 *   持有同一只是安全的：维度判定在 search 里每请求现查，不在构造期凝固。
 * assemble 保持 public 只因为 private 跨类不可见，不是对外的装配入口。
 */

export { RetrieverFactory, RetrieverError }

import 'reflect-metadata'
import { embedMany } from 'ai'
import { singleton } from 'tsyringe'
import { createRetrieverStageRegistry } from './recipes'

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

    const search = async (Query: string, Options?: { limit?: number }) => {
      const trimmed = Query.trim()
      if (!trimmed) throw new RetrieverError('E_EMPTY_QUERY', '提问不能为空')

      const stored = await Deps.repo.dimensionsInStore()
      const foreign = stored.filter((Dim) => Dim !== Deps.config.embeddingDimensions)
      if (foreign.length > 0) {
        throw new RetrieverError(
          'E_DIMENSION_MISMATCH',
          `库中存在 ${foreign.join('/')} 维向量，与当前检索维度 ${Deps.config.embeddingDimensions} 不符，拒绝作答`
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

      const vectorHits: RetrievedChunk[] = await vector.search(queryVector, Deps.config.retrievalVectorTopK)
      const lexicalHits: RetrievedChunk[] = lexical
        ? await lexical.search(trimmed, Deps.config.retrievalLexicalTopK)
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
