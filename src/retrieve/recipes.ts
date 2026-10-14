/**
 * 检索 stage 注册表 —— 名字→构造函数，工厂据此把 Recipe 里的策略名兑换成实例。纯目录、无来源分支，查有一律返回 undefined。
 * 这里是 orchestration 层唯一允许 `new` 检索 stage 的位置（与 pipeline/recipes.ts 同一条规矩）。
 * embedders 表 import 的是 pipeline/embed/qwenembed 同一个类：全库只允许一个 embedding 模型，检索与入库必须用它产同一个向量，
 * 把类挪进 adapters/ 会动到入库地基，所以这里只跨一条 import。
 * RETRIEVER_RECIPE_NAMES 是这张表的名字清单：两条路由装 Recipe 时展开它，策略名不在第二处重复写死。
 * lexicalSearches 与 vectorSearches 一样读库，构造只吃 pool（词路不吃维度：BM25 索引建在 chunks.content 上，与向量维度无关）。
 */

export { createRetrieverStageRegistry, RETRIEVER_RECIPE_NAMES }

import { ParadeDbVectorSearch } from './search/paradedb-vector'
import { ParadeDbBm25Search } from './search/paradedb-bm25'
import { RrfFuser } from './fusion/rrf'
import { QwenEmbedder } from '../pipeline/embed/qwenembed'

import type { RetrieverDeps, RetrieverStageRegistry, VectorSearcher, LexicalSearcher, Fuser } from './contracts'
import type { Embedder } from '../ports/embedder'

const RETRIEVER_RECIPE_NAMES = {
  vectorSearch: 'paradedb-vector',
  lexicalSearch: 'paradedb-bm25',
  fusion: 'rrf',
  embedder: 'qwenembed',
} as const

function createRetrieverStageRegistry(): RetrieverStageRegistry {
  const vectorSearches: Record<string, (d: RetrieverDeps) => VectorSearcher> = {
    'paradedb-vector': (d) => new ParadeDbVectorSearch(d),
  }
  const lexicalSearches: Record<string, (d: RetrieverDeps) => LexicalSearcher> = {
    'paradedb-bm25': (d) => new ParadeDbBm25Search(d),
  }
  const fusions: Record<string, (d: RetrieverDeps) => Fuser> = {
    rrf: (d) => new RrfFuser(d),
  }
  const embedders: Record<string, (d: RetrieverDeps) => Embedder> = {
    qwenembed: (d) =>
      new QwenEmbedder({
        ollamaBaseUrl: d.config.ollamaBaseUrl,
        embeddingModel: d.config.embeddingModel,
        embeddingDimensions: d.config.dimension,
      }),
  }

  return {
    vectorSearch: (Name, Deps) => instantiate(vectorSearches, Name, Deps),
    lexicalSearch: (Name, Deps) => instantiate(lexicalSearches, Name, Deps),
    fusion: (Name, Deps) => instantiate(fusions, Name, Deps),
    embedder: (Name, Deps) => instantiate(embedders, Name, Deps),
  }
}

function instantiate<T>(
  Table: Record<string, (d: RetrieverDeps) => T>,
  Name: string,
  Deps: RetrieverDeps
): T | undefined {
  return Object.hasOwn(Table, Name) ? Table[Name]!(Deps) : undefined
}
