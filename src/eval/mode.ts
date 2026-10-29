/**
 * 运行模式推断 —— 不加列，读快照：metric 配置的 judge_model 非空，或任一 case 有断言，就是答案评测 run；否则仍是 7.2 的检索 run。
 * 判定只用建 run 时冻结的快照，之后改题集或配置不会改变历史 run 的模式。
 */

export { inferRunMode }
export type { EvalRunMode }

import type { EvalRunSnapshot } from '../adapter/contract'

type EvalRunMode = 'retrieval' | 'answer'

function inferRunMode(Snapshot: EvalRunSnapshot): EvalRunMode {
  const Judge = Snapshot.metric_config?.config?.judge_model
  if (typeof Judge === 'string' && Judge.trim() !== '') return 'answer'
  const Cases = Array.isArray(Snapshot.cases) ? Snapshot.cases : []
  for (const Case of Cases) {
    if (Case.assertions === undefined || Case.assertions === null) continue
    if (Case.assertions.expect.length > 0 || Case.assertions.reject.length > 0) return 'answer'
  }
  return 'retrieval'
}
