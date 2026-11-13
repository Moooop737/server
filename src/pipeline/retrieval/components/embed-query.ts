/**
 * embed_query —— 把 text 编成查询向量；模型按 端口 > 引脚默认 > 全局默认 解析。
 * 解析放进 stage 内：指定模型不存在/不可用时也能留下一条 failed stage。
 * 输出带上 model_key / dimension，下游 vector_recall 不需要再问 registry。
 */

export { EmbedQuery }

import { z } from 'zod'
import { runStage } from '../../../trace/systemtrace/stage'
import { EmbeddingSchema } from './schemas'
import { embedText, hashVector, resolveEmbedding } from './shared'

import type { ComponentDef, Stage } from '../pipeline'

const EmbedQueryConfig = z.strictObject({ model: z.string().optional() })

const EmbedQuery: ComponentDef = {
  name: 'embed_query',
  description: '把 text 编成查询向量；模型按端口 / 引脚默认 / 全局默认解析',
  input: z.object({ text: z.string(), model: z.string().optional() }),
  output: z.object({ embedding: EmbeddingSchema }),
  config: EmbedQueryConfig,
  create: (Config, Deps): Stage => {
    const C = EmbedQueryConfig.parse(Config)
    return {
      async run(Input) {
        const Text = String(Input.text ?? '')
        const Wired = nonEmpty(Input.model)
        const Pinned = nonEmpty(C.model)
        const Key = Wired ?? Pinned
        const Source = Wired !== null ? 'wire' : Pinned !== null ? 'pin-default' : 'runtime-default'
        const Result = await runStage(
          Deps.sink,
          'embed_query',
          {
            query: Text,
            requested_model: Key,
            model_source: Source,
            node_id: Deps.nodeId,
          },
          async () => {
            const Embedding = resolveEmbedding(Deps, Key)
            const Pre = Deps.precomputed
            const Reused = Pre !== undefined && Pre.text === Text && Pre.model_key === Embedding.key
            const Vector = Pre !== undefined && Reused
              ? Pre.vector
              : await embedText(Embedding, Text, Deps.sink.embedTelemetry !== 'off')
            return { Embedding, Reused, Vector }
          },
          (Output) => ({
            model_id: Output.Embedding.model_id,
            model_key: Output.Embedding.key,
            dimensions: Output.Embedding.dimensions,
            reused: Output.Reused,
            dimension: Output.Vector.length,
            vector_hash: hashVector(Output.Vector),
          }),
        )
        return {
          embedding: {
            vector: Result.Vector,
            model_key: Result.Embedding.key,
            dimension: Result.Vector.length,
            kind: 'embedding',
          },
        }
      },
    }
  },
}

function nonEmpty(Value: unknown): string | null {
  if (typeof Value !== 'string') return null
  const Trimmed = Value.trim()
  return Trimmed === '' ? null : Trimmed
}
