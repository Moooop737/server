/**
 * vector_recall —— 先自检当前模型名下没有异维向量，再按查询向量召回；相似度阈值是本组件参数。
 * 原 dimension_check 并入本组件：检查与召回同在一个 stage 内，混维即 E_DIMENSION_MISMATCH，拒绝召回。
 * 阈值过滤留在组件（写进 SQL 会挡 HNSW 的 top-k 通道）；sources.count 是过阈值后的条数。
 */

export { VectorRecall }

import { z } from 'zod'
import { runStage } from '../../../trace/systemtrace/stage'
import { RetrieverError } from '../../contracts'
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
  description: '先自检当前模型名下无混维，再按查询向量召回；阈值是本组件参数',
  input: z.object({ embedding: EmbeddingSchema }),
  output: z.object({ list: RankedListSchema }),
  config: VectorRecallConfig,
  create: (Config, Deps): Stage => {
    const C = VectorRecallConfig.parse(Config)
    return {
      async run(Input) {
        const Embedding = Input.embedding as Embedding
        const Checked = await runStage(
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
          async () => {
            const Stored = await Deps.repo.dimensionsInStore(Embedding.model_key)
            const Foreign = Stored.filter((Dim) => Dim !== Embedding.dimension)
            if (Foreign.length > 0) {
              throw new RetrieverError(
                'E_DIMENSION_MISMATCH',
                `当前嵌入模型 ${Embedding.model_key} 下存在 ${Foreign.join('/')} 维向量，与检索维度 ${Embedding.dimension} 不符，拒绝作答`,
              )
            }
            const Candidates = await Deps.repo.vectorCandidates(
              Embedding.vector,
              C.top_k,
              Embedding.dimension,
              Embedding.model_key,
            )
            return { stored_dimensions: Stored, candidates: Candidates }
          },
          (Output) => ({
            stored_dimensions: Output.stored_dimensions,
            candidates: Output.candidates.map((Hit, Index) => ({
              chunk_id: Hit.chunk.id,
              similarity: Hit.similarity,
              rank: Index + 1,
            })),
          }),
        )
        const Items: RetrievedChunk[] = Checked.candidates
          .filter((Hit) => Hit.similarity !== null && Hit.similarity >= C.min_similarity)
          .map((Hit) => ({ ...Hit, score: 0 }))
        return { list: listOf('vector', Items) }
      },
    }
  },
}
