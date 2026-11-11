/**
 * embed_query —— 把 text 编成查询向量；模型与维度来自本次 run 的嵌入快照。
 * 输出带上 model_key / dimension，下游 vector_recall 不需要再问 registry。
 */

export { EmbedQuery }

import { z } from 'zod'
import { runStage } from '../../../trace/systemtrace/stage'
import { EmbeddingSchema } from './schemas'
import { embedText, hashVector, requireEmbedding } from './shared'

import type { ComponentDef, Stage } from '../pipeline'

const EmbedQueryConfig = z.strictObject({})

const EmbedQuery: ComponentDef = {
  name: 'embed_query',
  description: '把 text 编成查询向量；模型与维度来自本次 run 的嵌入快照',
  requiresEmbedding: true,
  input: z.object({ text: z.string() }),
  output: z.object({ embedding: EmbeddingSchema }),
  config: EmbedQueryConfig,
  create: (Config, Deps): Stage => {
    EmbedQueryConfig.parse(Config)
    return {
      async run(Input) {
        const Embedding = requireEmbedding(Deps)
        const Text = String(Input.text ?? '')
        const Pre = Deps.precomputed
        const Reused = Pre !== undefined && Pre.text === Text
        const Vector = await runStage(
          Deps.sink,
          'embed_query',
          {
            query: Text,
            model_id: Embedding.model_id,
            model_key: Embedding.key,
            dimensions: Embedding.dimensions,
            reused: Reused,
            node_id: Deps.nodeId,
          },
          async () => (
            Pre !== undefined && Pre.text === Text
              ? Pre.vector
              : embedText(Embedding, Text, Deps.sink.embedTelemetry !== 'off')
          ),
          (Result) => ({ dimension: Result.length, vector_hash: hashVector(Result) }),
        )
        return {
          embedding: {
            vector: Vector,
            model_key: Embedding.key,
            dimension: Vector.length,
            kind: 'embedding',
          },
        }
      },
    }
  },
}
