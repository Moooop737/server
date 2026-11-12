/**
 * worker 节点配置 —— model 按名兑换、prompt 是系统提示、step_limit 是 agent loop 的步预算。
 * step_limit 可省略；缺省值由装配侧决定，本文件只管字段契约。
 */

export { WorkerConfigSchema, WORKER_DEFAULT_STEP_LIMIT }
export type { WorkerConfig }

import { z } from 'zod'

const WORKER_DEFAULT_STEP_LIMIT = 5

const WorkerConfigSchema = z.strictObject({
  model_key: z.string().trim().min(1, 'model_key 不能为空'),
  prompt: z.string().trim().min(1, 'prompt 不能为空'),
  step_limit: z.number().int('step_limit 需为整数').min(1, 'step_limit 需在 1–20').max(20, 'step_limit 需在 1–20').optional(),
})

type WorkerConfig = z.infer<typeof WorkerConfigSchema>
