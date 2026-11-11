/**
 * dimension_check —— 只查当前嵌入模型的维度集合；当前模型内混维则拒答。
 * 无数据边，靠执行器「所有节点都跑」执行；校验在 embed 之前完成，不花一次 embedding。
 */

export { DimensionCheck }

import { z } from 'zod'
import { runStage } from '../../../trace/systemtrace/stage'
import { RetrieverError } from '../../contracts'
import { requireEmbedding } from './shared'

import type { ComponentDef, Stage } from '../pipeline'

const DimensionCheckConfig = z.strictObject({})

const DimensionCheck: ComponentDef = {
  name: 'dimension_check',
  description: '只查当前嵌入模型的维度集合；当前模型内混维则拒答',
  requiresEmbedding: true,
  input: z.object({}),
  output: z.object({}),
  config: DimensionCheckConfig,
  create: (Config, Deps): Stage => {
    DimensionCheckConfig.parse(Config)
    return {
      async run() {
        const Embedding = requireEmbedding(Deps)
        if (Embedding.dimensions === null) {
          throw new RetrieverError('E_NO_EMBEDDING_MODEL', '未配置可用的默认嵌入模型')
        }
        const Stored = await Deps.repo.dimensionsInStore(Embedding.key)
        const Foreign = Stored.filter((Dim) => Dim !== Embedding.dimensions)
        await runStage(
          Deps.sink,
          'dimension_check',
          {
            expected_dimension: Embedding.dimensions,
            stored_dimensions: Stored,
            model_key: Embedding.key,
            node_id: Deps.nodeId,
          },
          async () => {
            if (Foreign.length > 0) {
              throw new RetrieverError(
                'E_DIMENSION_MISMATCH',
                `当前嵌入模型 ${Embedding.key} 下存在 ${Foreign.join('/')} 维向量，与检索维度 ${Embedding.dimensions} 不符，拒绝作答`,
              )
            }
            return { foreign_dimensions: [] as number[] }
          },
          (Output) => Output,
        )
        return {}
      },
    }
  },
}
