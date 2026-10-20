/**
 * 检索 stage 注册表 —— 名字→构造函数，工厂据此把 Recipe 里的策略名兑换成实例。纯目录、无来源分支，查有一律返回 undefined。
 * 这里是检索编排层唯一允许 `new` 检索 stage 的位置（与 ingest/recipes.ts 同一条规矩）。
 * embed 不在表里：它曾跨盒 import 旧 `pipeline/`（现 `ingest/`）里的 embed/qwenembed 同一个类（全库只允许一个 embedding 模型，两边必须同模型），
 * 现在两边拿的是装配层从 model 清单选定的同一个 EmbeddingHandle，那条跨盒 import 随之下线。
 * RETRIEVER_RECIPE_NAMES 是这张表的名字清单：RetrieverHandle 装 Recipe 时展开它，策略名不在第二处重复写死。
 * lexicalSearches 与 vectorSearches 一样读库，构造只吃 repo（词路不吃维度：BM25 索引建在 chunks.content 上，与向量维度无关）。
 */

export { createRetrieverStageRegistry, RETRIEVER_RECIPE_NAMES }

import { ParadeDbVectorSearch } from './search/paradedb-vector'
import { ParadeDbBm25Search } from './search/paradedb-bm25'
import { RrfFuser } from './fusion/rrf'

import type { RetrieverDeps, RetrieverStageRegistry, VectorSearcher, LexicalSearcher, Fuser } from './contracts'

const RETRIEVER_RECIPE_NAMES = {
  vectorSearch: 'paradedb-vector',
  lexicalSearch: 'paradedb-bm25',
  fusion: 'rrf',
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

  return {
    vectorSearch: (Name, Deps) => instantiate(vectorSearches, Name, Deps),
    lexicalSearch: (Name, Deps) => instantiate(lexicalSearches, Name, Deps),
    fusion: (Name, Deps) => instantiate(fusions, Name, Deps),
  }
}

function instantiate<T>(
  Table: Record<string, (d: RetrieverDeps) => T>,
  Name: string,
  Deps: RetrieverDeps
): T | undefined {
  return Object.hasOwn(Table, Name) ? Table[Name]!(Deps) : undefined
}
