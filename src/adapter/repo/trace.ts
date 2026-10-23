/**
 * traces 的写侧 —— 端点观测的公共行，一次 HTTP 请求一行：insertTrace 建 running 行，finishTrace 收口。
 * trace_stages 是阶段表，归 3.3/3.4 使用，本文件不碰；读侧（list/read）由 routes/crud.ts 注册到 hono-crud。
 * payloads 由端点壳采集：失败请求记 request/response，成功只对白名单接口记 request；单侧 body 上限 3KB。
 * session_id / langfuse_trace_id 由 /chat 在流开始与结束时补写；finishTrace 对它们用 COALESCE，端点壳的响应头收口不会把它们抹掉。
 * finishTrace 只按主键更新，命中 0 行不报错 —— 观测写失败不该影响业务，吞错与日志由调用方负责（见 trace/systemtrace/endpoint.ts）。
 */

export { insertTrace, finishTrace, setTraceSession }
export type { TraceStart, TraceFinish, TracePayloads, TracePayloadSide, TracePayloadOmitReason }

import type { Pool } from 'pg'

type TraceStatus = 'running' | 'ok' | 'error' | 'cancelled'
type TracePayloadOmitReason = 'too_large' | 'policy' | 'not_json'

interface TracePayloadSide {
  headers?: Record<string, string>
  body?: unknown
}

interface TracePayloads {
  request?: TracePayloadSide
  response?: TracePayloadSide
  omitted?: {
    request_body?: { reason: TracePayloadOmitReason; bytes: number }
    response_body?: { reason: TracePayloadOmitReason; bytes: number }
  }
}

interface TraceStart {
  id: string
  route: string
  started_at: string
}

interface TraceFinish {
  ended_at: string
  duration_ms: number
  http_status: number
  status: Exclude<TraceStatus, 'running'>
  error_code: string | null
  payloads: TracePayloads | null
  session_id?: string | null
  langfuse_trace_id?: string | null
}

async function insertTrace(Db: Pool, Entry: TraceStart): Promise<void> {
  await Db.query(
    `INSERT INTO traces (id, route, started_at, status) VALUES ($1, $2, $3, 'running')`,
    [Entry.id, Entry.route, Entry.started_at],
  )
}

async function finishTrace(Db: Pool, TraceId: string, Finish: TraceFinish): Promise<void> {
  await Db.query(
    `UPDATE traces
        SET ended_at = $2, duration_ms = $3, http_status = $4, status = $5, error_code = $6,
            session_id = COALESCE($7, session_id),
            langfuse_trace_id = COALESCE($8, langfuse_trace_id),
            payloads = $9
      WHERE id = $1`,
    [
      TraceId,
      Finish.ended_at,
      Finish.duration_ms,
      Finish.http_status,
      Finish.status,
      Finish.error_code,
      Finish.session_id ?? null,
      Finish.langfuse_trace_id ?? null,
      Finish.payloads === null ? null : JSON.stringify(Finish.payloads),
    ],
  )
}

async function setTraceSession(Db: Pool, TraceId: string, SessionId: string): Promise<void> {
  await Db.query(`UPDATE traces SET session_id = $2 WHERE id = $1`, [TraceId, SessionId])
}
