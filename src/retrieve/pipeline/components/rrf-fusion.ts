/**
 * rrf_fusion —— 两个有序列表按名次融合；只有一个输入时退化为单路，外层重新编号。
 * a / b 由边决定，组件不关心谁是向量、谁是词法；a_weight / b_weight 是两路的相对权重（0–1，乘进贡献分）。
 * 同 chunk 去重累加，sources 同名计数合并。
 */

export { RrfFusion }

import { z } from 'zod'
import { runStage } from '../../../trace/systemtrace/stage'
import { RankedListSchema } from './schemas'
import { rrf } from './shared'

import type { ComponentDef, Stage } from '../pipeline'
import type { RankedList } from './schemas'

const RrfFusionConfig = z.strictObject({
  k: z.number().int().min(1).max(1000),
  a_weight: z.number().min(0).max(1),
  b_weight: z.number().min(0).max(1),
})

const RrfFusion: ComponentDef = {
  name: 'rrf_fusion',
  description: '两个有序列表按名次融合；a/b 权重可调，只有一个输入时退化为单路',
  input: z.object({ a: RankedListSchema, b: RankedListSchema.optional() }),
  output: z.object({ list: RankedListSchema }),
  config: RrfFusionConfig,
  create: (Config, Deps): Stage => {
    const C = RrfFusionConfig.parse(Config)
    return {
      async run(Input) {
        const A = Input.a as RankedList
        const B = Input.b as RankedList | undefined
        const Lists = B === undefined ? [A] : [A, B]
        const Weights = B === undefined ? [C.a_weight] : [C.a_weight, C.b_weight]
        const Result = rrf(Lists, C.k, Weights)
        await runStage(
          Deps.sink,
          'rrf_fusion',
          {
            a: A.items.map((Item, Index) => ({ chunk_id: Item.chunk.id, rank: Index + 1 })),
            ...(B === undefined ? {} : { b: B.items.map((Item, Index) => ({ chunk_id: Item.chunk.id, rank: Index + 1 })) }),
            k: C.k,
            a_weight: C.a_weight,
            b_weight: C.b_weight,
            node_id: Deps.nodeId,
          },
          async () => Result,
          (Output) => ({
            hits: Output.items.map((Item) => ({ chunk_id: Item.chunk.id, rrf_score: Item.score })),
            sources: Output.sources,
          }),
        )
        return { list: Result }
      },
    }
  },
}
