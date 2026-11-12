/**
 * retriever 节点配置 —— pipeline_id 指向 pipeline_defs；省略时装配侧按 default 处理。
 * 本文件只存指向，不校验管线是否存在（那是装配 / 预检的事）。
 */

export { RetrieverConfigSchema }
export type { RetrieverConfig }

import { z } from 'zod'

const RetrieverConfigSchema = z.strictObject({
  pipeline_id: z.string().trim().min(1, 'pipeline_id 不能为空').optional(),
})

type RetrieverConfig = z.infer<typeof RetrieverConfigSchema>
