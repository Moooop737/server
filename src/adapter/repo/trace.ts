/**
 * traces 的写侧 —— 端点观测的公共行，一次 HTTP 请求一行：insertTrace 建 running 行，finishTrace 收口。
 * trace_stages 是阶段表，归 3.3/3.4 使用，本文件不碰；读侧（list/read）由 routes/crud.ts 注册到 hono-crud。
 * payloads 由端点壳采集：失败请求记 request/response，成功只对白名单接口记 request；单侧 body 上限 3KB。
 * session_id / langfuse_trace_id 由 /chat 在流开始与结束时补写；finishTrace 对它们用 COALESCE，端点壳的响应头收口不会把它们抹掉。
 * trace_stages 是阶段表：insertTraceStage 写、listTraceStages 读；读侧 getTrace 供自定义 /traces/:id。
 * finishTrace 只按主键更新，命中 0 行不报错 —— 观测写失败不该影响业务，吞错与日志由调用方负责（见 trace/systemtrace/endpoint.ts）。
 */

export { insertTrace, finishTrace, setTraceSession, setTraceResource, getTrace, insertTraceStage, listTraceStages }
export type { TraceStart, TraceFinish, TracePayloads, TracePayloadSide, TracePayloadOmitReason, Trace, TraceStage, TraceStageInput }

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

interface Trace {
  id: string
  session_id: string | null
  resource_id: string | null
  route: string
  http_status: number | null
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  status: TraceStatus
  error_code: string | null
  langfuse_trace_id: string | null
  payloads: TracePayloads | null
  created_at: string
}

interface TraceStage {
  id: string
  trace_id: string
  stage: string
  input: unknown
  output: unknown
  duration_ms: number
  status: 'ok' | 'error'
  created_at: string
}

interface TraceStageInput {
  stage: string
  input: unknown
  output: unknown
  duration_ms: number
  status: 'ok' | 'error'
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

async function setTraceResource(Db: Pool, TraceId: string, ResourceId: string): Promise<void> {
  await Db.query(`UPDATE traces SET resource_id = $2 WHERE id = $1`, [TraceId, ResourceId])
}

async function getTrace(Db: Pool, TraceId: string): Promise<Trace | null> {
  const { rows } = await Db.query(`SELECT * FROM traces WHERE id = $1`, [TraceId])
  return rows[0] ? rowToTrace(rows[0]) : null
}

async function insertTraceStage(Db: Pool, TraceId: string, Stage: TraceStageInput): Promise<void> {
  await Db.query(
    `INSERT INTO trace_stages (trace_id, stage, input, output, duration_ms, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [TraceId, Stage.stage, JSON.stringify(Stage.input), JSON.stringify(Stage.output), Stage.duration_ms, Stage.status],
  )
}

async function listTraceStages(Db: Pool, TraceId: string): Promise<TraceStage[]> {
  const { rows } = await Db.query(
    `SELECT id, trace_id, stage, input, output, duration_ms, status, created_at
       FROM trace_stages WHERE trace_id = $1 ORDER BY created_at ASC`,
    [TraceId],
  )
  return rows.map(rowToTraceStage)
}

function rowToTrace(r: any): Trace {
  return {
    id: r.id,
    session_id: r.session_id,
    resource_id: r.resource_id,
    route: r.route,
    http_status: r.http_status,
    started_at: iso(r.started_at)!,
    ended_at: iso(r.ended_at),
    duration_ms: r.duration_ms,
    status: r.status,
    error_code: r.error_code,
    langfuse_trace_id: r.langfuse_trace_id,
    payloads: r.payloads ?? null,
    created_at: iso(r.created_at)!,
  }
}

function rowToTraceStage(r: any): TraceStage {
  return {
    id: r.id,
    trace_id: r.trace_id,
    stage: r.stage,
    input: parseJson(r.input),
    output: parseJson(r.output),
    duration_ms: r.duration_ms,
    status: r.status,
    created_at: iso(r.created_at)!,
  }
}

// Date → ISO string; null → null。pg 读回的 timestamptz 是 Date 实例，这一位不许越过本层
function iso(v: Date | string | null): string | null {
  if (v === null) return null
  return v instanceof Date ? v.toISOString() : v
}

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}
