/**
 * 运行模式 —— 优先用建 run 时显式选的 mode（存在快照里）；旧 run 没有这一位时按配置推断：
 * judge_model 非空或任一 case 有断言 → answer，否则 retrieval。
 * 读的是快照，之后改题集或配置不会改变历史 run 的模式。
 */

export { inferRunMode }
export type { EvalRunMode }

import type { EvalRunSnapshot } from '../adapter/contract'

type EvalRunMode = 'retrieval' | 'answer'

function inferRunMode(Snapshot: EvalRunSnapshot): EvalRunMode {
  if (Snapshot.mode === 'retrieval' || Snapshot.mode === 'answer') return Snapshot.mode
  const Judge = Snapshot.metric_config?.config?.judge_model
  if (typeof Judge === 'string' && Judge.trim() !== '') return 'answer'
  const Cases = Array.isArray(Snapshot.cases) ? Snapshot.cases : []
  for (const Case of Cases) {
    if (Case.assertions === undefined || Case.assertions === null) continue
    if (Case.assertions.expect.length > 0 || Case.assertions.reject.length > 0) return 'answer'
  }
  return 'retrieval'
}
