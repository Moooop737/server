/**
 * input —— 管线显式入口：把执行器根输入摊成 query / model 两个端口。
 * 无 stage：纯适配，没有可观测的业务动作。
 */

export { InputNode }

import { z } from 'zod'
import type { ComponentDef, Stage } from '../pipeline'

const InputConfig = z.strictObject({})

const InputNode: ComponentDef = {
  name: 'input',
  description: '把管线根输入摊成 query / model 两个端口',
  input: z.object({ query: z.string(), model: z.string().optional() }),
  output: z.object({ query: z.string(), model: z.string().optional() }),
  config: InputConfig,
  create: (Config): Stage => {
    InputConfig.parse(Config)
    return {
      async run(Input) {
        const Query = String(Input.query ?? '')
        const Model = typeof Input.model === 'string' ? Input.model : undefined
        return { query: Query, ...(Model === undefined ? {} : { model: Model }) }
      },
    }
  },
}
