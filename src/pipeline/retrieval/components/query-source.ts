/**
 * query_source —— 管线唯一的「问句源」：把执行器传入的根输入摊成 text 槽。
 * 没有 stage：这是纯适配，没有可观测的业务动作。
 */

export { QuerySource }

import { z } from 'zod'
import type { ComponentDef, Stage } from '../pipeline'

const QuerySourceConfig = z.strictObject({})

const QuerySource: ComponentDef = {
  name: 'query_source',
  description: '把管线输入的问句摊成 text 槽',
  input: z.object({ query: z.string() }),
  output: z.object({ text: z.string() }),
  config: QuerySourceConfig,
  create: (Config): Stage => {
    QuerySourceConfig.parse(Config)
    return {
      async run(Input) {
        return { text: String(Input.query ?? '') }
      },
    }
  },
}
