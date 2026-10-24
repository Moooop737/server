/**
 * 通用 stage runner —— retrieve 与 ingest 共用：计时、成功/失败记录、失败后原样抛出。
 * StageSink 由 caller 选（DB / Langfuse / no-op），runner 不关心落点；不是 stage 的处理逻辑。
 * StageRecord 的 input/output 必须是阶段专用元数据：不写 chunk 正文、不写完整向量。
 * 失败 stage 的 output 固定为 { error_code, message }，后续 stage 由调用方决定不再执行。
 */

export { runStage, NoopStageSink }
export type { StageName, StageRecord, StageSink }

import { logError } from './log'

type StageName =
  | 'dimension_check'
  | 'embed_query'
  | 'vector_recall'
  | 'bm25_recall'
  | 'rrf_fusion'
  | 'fetch'
  | 'parse'
  | 'chunk'
  | 'embed'
  | 'write'

interface StageRecord {
  stage: StageName
  input: unknown
  output: unknown
  duration_ms: number
  status: 'ok' | 'error'
  started_at: string
  ended_at: string
}

interface StageSink {
  embedTelemetry: 'on' | 'off'
  record(Record: StageRecord): Promise<void> | void
}

const NoopStageSink: StageSink = {
  embedTelemetry: 'off',
  record() {},
}

async function runStage<T>(
  Sink: StageSink,
  Stage: StageName,
  Input: unknown,
  Fn: () => Promise<T>,
  Output: (Result: T) => unknown,
): Promise<T> {
  const Started = Date.now()
  const StartedAt = new Date(Started).toISOString()
  try {
    const Result = await Fn()
    await recordStage(Sink, {
      stage: Stage,
      input: Input,
      output: Output(Result),
      duration_ms: Date.now() - Started,
      status: 'ok',
      started_at: StartedAt,
      ended_at: new Date().toISOString(),
    })
    return Result
  } catch (Err) {
    await recordStage(Sink, {
      stage: Stage,
      input: Input,
      output: { error_code: codeOf(Err), message: messageOf(Err) },
      duration_ms: Date.now() - Started,
      status: 'error',
      started_at: StartedAt,
      ended_at: new Date().toISOString(),
    })
    throw Err
  }
}

async function recordStage(Sink: StageSink, Record: StageRecord): Promise<void> {
  try {
    await Sink.record(Record)
  } catch (Err) {
    logError('E_TRACE_WRITE', `写入 stage 失败: ${String(Err)}`)
  }
}

function codeOf(Err: unknown): string {
  if (Err !== null && typeof Err === 'object' && 'code' in Err) {
    const Code = (Err as { code?: unknown }).code
    if (typeof Code === 'string') return Code
  }
  return 'E_STAGE'
}

function messageOf(Err: unknown): string {
  return Err instanceof Error ? Err.message : String(Err)
}
