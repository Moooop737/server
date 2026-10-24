/**
 * DB stage sink —— retrieve 与 ingest 共用：把 stage 写进本地 trace_stages；trace_id 从端点壳的 ALS 取。
 * 本 sink 同时声明 embedTelemetry='off'：这些 embedMany 不能再被全局 Langfuse integration 记成独立 trace。
 * 写入失败只记 E_TRACE_WRITE，不拖垮业务（观测是旁路）。
 */

export { createDbStageSink }

import { currentTraceId, logError } from './log'

import type { Repo } from '../../adapter/contract'
import type { StageSink } from './stage'

function createDbStageSink(Repo: Pick<Repo, 'insertTraceStage'>): StageSink {
  return {
    embedTelemetry: 'off',
    async record(Stage) {
      const TraceId = currentTraceId()
      if (TraceId === undefined) return
      try {
        await Repo.insertTraceStage(TraceId, {
          stage: Stage.stage,
          input: Stage.input,
          output: Stage.output,
          duration_ms: Stage.duration_ms,
          status: Stage.status,
        })
      } catch (err) {
        logError('E_TRACE_WRITE', `写入 trace_stage 失败: ${String(err)}`)
      }
    },
  }
}
