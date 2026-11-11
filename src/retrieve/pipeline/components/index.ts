/**
 * 检索组件目录 —— 纯目录，无来源分支；组件名即 key。
 * 每个组件一文件；schema 与跨组件工具分别住 schemas.ts / shared.ts。
 */

export { RETRIEVAL_COMPONENTS }
export { ChunkSchema, RankedItemSchema, SourceCountSchema, RankedListSchema, EmbeddingSchema } from './schemas'
export type { RankedItem, RankedList, Embedding } from './schemas'

import { QuerySource } from './query-source'
import { DimensionCheck } from './dimension-check'
import { EmbedQuery } from './embed-query'
import { VectorRecall } from './vector-recall'
import { Bm25Recall } from './bm25-recall'
import { RrfFusion } from './rrf-fusion'
import { Result } from './result'

import type { ComponentDef } from '../pipeline'

const RETRIEVAL_COMPONENTS = new Map<string, ComponentDef>([
  [QuerySource.name, QuerySource],
  [DimensionCheck.name, DimensionCheck],
  [EmbedQuery.name, EmbedQuery],
  [VectorRecall.name, VectorRecall],
  [Bm25Recall.name, Bm25Recall],
  [RrfFusion.name, RrfFusion],
  [Result.name, Result],
])
