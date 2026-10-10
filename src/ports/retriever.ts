import type { Chunk } from '../types'

export interface Retriever {
  // 向量 HNSW + pg_search BM25 混合，按 score 降序
  search(
    query: string,
    options?: { limit?: number; minScore?: number }
  ): Promise<{ chunk: Chunk; score: number }[]>
}
