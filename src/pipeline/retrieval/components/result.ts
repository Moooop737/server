/**
 * result —— 截断融合结果并投影两路计数；limit 是本组件参数。
 * 输出保持 RetrievalResult 的 hits / vectorCount / lexicalCount，路由与工具不再二次映射。
 */

export { Result }

import { z } from 'zod'
import { RankedItemSchema, RankedListSchema } from './schemas'

import type { ComponentDef, Stage } from '../pipeline'
import type { RankedList } from './schemas'

const ResultConfig = z.strictObject({ limit: z.number().int().min(1).max(100) })

const Result: ComponentDef = {
  name: 'result',
  description: '截断融合结果并投影两路计数；limit 是本组件参数',
  input: z.object({ list: RankedListSchema }),
  output: z.object({
    hits: z.array(RankedItemSchema),
    vectorCount: z.number().int(),
    lexicalCount: z.number().int(),
  }),
  config: ResultConfig,
  create: (Config): Stage => {
    const C = ResultConfig.parse(Config)
    return {
      async run(Input) {
        const List = Input.list as RankedList
        return {
          hits: List.items.slice(0, C.limit),
          vectorCount: List.sources.find((Item) => Item.name === 'vector')?.count ?? 0,
          lexicalCount: List.sources.find((Item) => Item.name === 'lexical')?.count ?? 0,
        }
      },
    }
  },
}
