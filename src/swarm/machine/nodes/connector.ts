/**
 * connector 节点配置 —— kind 是外部能力的名字（web_search / im / …）。
 * v1 连接器注册表为空，本文件只认字段非空；kind 是否已实现由装配 / 预检判断。
 */

export { ConnectorConfigSchema }
export type { ConnectorConfig }

import { z } from 'zod'

const ConnectorConfigSchema = z.strictObject({
  kind: z.string().trim().min(1, 'kind 不能为空'),
})

type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>
