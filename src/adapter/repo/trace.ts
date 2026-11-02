/**
 * traces 的写侧 —— 端点观测的公共行，一次 HTTP 请求一行：insertTrace 建 running 行，finishTrace 收口。
 * trace_stages 是阶段表，归 3.3/3.4 使用；读侧（list/read）由 routes/crud.ts 注册到 hono-crud。
 * payloads 由端点壳采集：失败请求记 request/response，成功只对白名单接口记 request；单侧 body 上限 3KB。
 * session_id / langfuse_trace_id 由 /chat 在流开始与结束时补写；finishTrace 只写调用方给的非空值，端点壳的响应头收口不会把它们抹掉。
 * trace_stages 是阶段表：insertTraceStage 写、listTraceStages 读；getTrace 供自定义 /traces/:id。
 * finishTrace 只按主键更新，命中 0 行不报错 —— 观测写失败不该影响业务，吞错与日志由调用方负责（见 trace/systemtrace/endpoint.ts）。
 * 全部走 Drizzle；jsonb 直接收对象，时间戳在边界把 ISO 字符串换成 Date。
 */

export { insertTrace, finishTrace, setTraceSession, setTraceResource, getTrace, insertTraceStage, listTraceStages }
export type { TraceStart, TraceFinish, TracePayloads, TracePayloadSide, TracePayloadOmitReason, Trace, TraceStage, TraceStageInput }

import { asc, eq } from 'drizzle-orm'
import { trace_stages, traces } from './orm/schema'
import type { Orm } from './orm/client'

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

async function insertTrace(Db: Orm, Entry: TraceStart): Promise<void> {
  await Db.insert(traces).values({
    id: Entry.id,
    route: Entry.route,
    started_at: new Date(Entry.started_at),
    status: 'running',
  })
}

async function finishTrace(Db: Orm, TraceId: string, Finish: TraceFinish): Promise<void> {
  await Db.update(traces)
    .set({
      ended_at: new Date(Finish.ended_at),
      duration_ms: Finish.duration_ms,
      http_status: Finish.http_status,
      status: Finish.status,
      error_code: Finish.error_code,
      ...(Finish.session_id != null ? { session_id: Finish.session_id } : {}),
      ...(Finish.langfuse_trace_id != null ? { langfuse_trace_id: Finish.langfuse_trace_id } : {}),
      payloads: Finish.payloads,
    })
    .where(eq(traces.id, TraceId))
}

async function setTraceSession(Db: Orm, TraceId: string, SessionId: string): Promise<void> {
  await Db.update(traces).set({ session_id: SessionId }).where(eq(traces.id, TraceId))
}

async function setTraceResource(Db: Orm, TraceId: string, ResourceId: string): Promise<void> {
  await Db.update(traces).set({ resource_id: ResourceId }).where(eq(traces.id, TraceId))
}

async function getTrace(Db: Orm, TraceId: string): Promise<Trace | null> {
  const rows = await Db.select().from(traces).where(eq(traces.id, TraceId)).limit(1)
  return rows[0] ? rowToTrace(rows[0]) : null
}

async function insertTraceStage(Db: Orm, TraceId: string, Stage: TraceStageInput): Promise<void> {
  await Db.insert(trace_stages).values({
    trace_id: TraceId,
    stage: Stage.stage,
    input: Stage.input,
    output: Stage.output,
    duration_ms: Stage.duration_ms,
    status: Stage.status,
  })
}

async function listTraceStages(Db: Orm, TraceId: string): Promise<TraceStage[]> {
  const rows = await Db.select({
    id: trace_stages.id,
    trace_id: trace_stages.trace_id,
    stage: trace_stages.stage,
    input: trace_stages.input,
    output: trace_stages.output,
    duration_ms: trace_stages.duration_ms,
    status: trace_stages.status,
    created_at: trace_stages.created_at,
  })
    .from(trace_stages)
    .where(eq(trace_stages.trace_id, TraceId))
    .orderBy(asc(trace_stages.created_at))
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

// Date → ISO string; null → null。时间戳经 Drizzle mode:'date' 读回是 Date 实例，这一位不许越过本层
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
