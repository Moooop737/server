/**
 * vector_recall —— 按查询向量召回；只用当前模型键的向量，相似度阈值是本组件参数。
 * 阈值过滤留在组件（写进 SQL 会挡 HNSW 的 top-k 通道）；sources.count 是过阈值后的条数。
 */

export { VectorRecall }

import { z } from 'zod'
import { runStage } from '../../../trace/systemtrace/stage'
import { EmbeddingSchema, RankedListSchema } from './schemas'
import { hashVector, listOf } from './shared'

import type { ComponentDef, Stage } from '../pipeline'
import type { RetrievedChunk } from '../../contracts'
import type { Embedding } from './schemas'

const VectorRecallConfig = z.strictObject({
  top_k: z.number().int().min(1).max(100),
  min_similarity: z.number().min(0).max(1),
})

const VectorRecall: ComponentDef = {
  name: 'vector_recall',
  description: '按查询向量召回；只用当前模型键的向量，相似度阈值是本组件参数',
  input: z.object({ embedding: EmbeddingSchema }),
  output: z.object({ list: RankedListSchema }),
  config: VectorRecallConfig,
  create: (Config, Deps): Stage => {
    const C = VectorRecallConfig.parse(Config)
    return {
      async run(Input) {
        const Embedding = Input.embedding as Embedding
        const Hits = await runStage(
          Deps.sink,
          'vector_recall',
          {
            vector_hash: hashVector(Embedding.vector),
            top_k: C.top_k,
            min_similarity: C.min_similarity,
            dimension: Embedding.dimension,
            model_key: Embedding.model_key,
            node_id: Deps.nodeId,
          },
          () => Deps.repo.vectorCandidates(Embedding.vector, C.top_k, Embedding.dimension, Embedding.model_key),
          (Candidates) => ({
            candidates: Candidates.map((Hit, Index) => ({ chunk_id: Hit.chunk.id, similarity: Hit.similarity, rank: Index + 1 })),
          }),
        )
        const Items: RetrievedChunk[] = Hits
          .filter((Hit) => Hit.similarity !== null && Hit.similarity >= C.min_similarity)
          .map((Hit) => ({ ...Hit, score: 0 }))
        return { list: listOf('vector', Items) }
      },
    }
  },
}
