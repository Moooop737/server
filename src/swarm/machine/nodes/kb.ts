/**
 * kb 节点配置 —— v1 只有一个知识库（主库 + 默认嵌入），label 只作展示名。
 * 嵌入身份与 repo 绑定由装配侧解析，不进节点配置。
 */

export { KbConfigSchema }
export type { KbConfig }

import { z } from 'zod'

const KbConfigSchema = z.strictObject({
  label: z.string().trim().min(1, 'label 不能为空').max(80, 'label 最长 80 字符').optional(),
})

type KbConfig = z.infer<typeof KbConfigSchema>
