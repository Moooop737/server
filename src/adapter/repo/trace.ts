/**
 * traces 的读写 —— 端点观测的公共行，一次 HTTP 请求一行：insertTrace 建 running 行，finishTrace 收口，getTrace/listTraces 供 /traces 回读。
 * trace_stages 是阶段表，归 3.3/3.4 使用，本文件不碰。
 * 行投影本层私有：timestamptz 的 Date 实例 → ISO 字符串，不让 Date 越过本层；status 的取值由迁移里的 CHECK 兜住。
 * finishTrace 只按主键更新，命中 0 行不报错 —— 观测写失败不该影响业务，吞错与日志由调用方负责（见 trace/systemtrace/endpoint.ts）。
 * listTraces 按 started_at 倒序；Limit 由路由层限幅，本层不再校验。
 */

export { insertTrace, finishTrace, getTrace, listTraces, rowToTrace }
export type { Trace, TraceStart, TraceFinish, TraceStatus }

import type { Pool } from 'pg'

type TraceStatus = 'running' | 'ok' | 'error' | 'cancelled'

interface Trace {
  trace_id: string
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
  created_at: string
}

interface TraceStart {
  trace_id: string
  route: string
  started_at: string
}

interface TraceFinish {
  ended_at: string
  duration_ms: number
  http_status: number
  status: Exclude<TraceStatus, 'running'>
  error_code: string | null
}

async function insertTrace(Db: Pool, Entry: TraceStart): Promise<void> {
  await Db.query(
    `INSERT INTO traces (trace_id, route, started_at, status) VALUES ($1, $2, $3, 'running')`,
    [Entry.trace_id, Entry.route, Entry.started_at],
  )
}

async function finishTrace(Db: Pool, TraceId: string, Finish: TraceFinish): Promise<void> {
  await Db.query(
    `UPDATE traces
        SET ended_at = $2, duration_ms = $3, http_status = $4, status = $5, error_code = $6
      WHERE trace_id = $1`,
    [TraceId, Finish.ended_at, Finish.duration_ms, Finish.http_status, Finish.status, Finish.error_code],
  )
}

async function getTrace(Db: Pool, TraceId: string): Promise<Trace | null> {
  const { rows } = await Db.query(`SELECT * FROM traces WHERE trace_id = $1`, [TraceId])
  return rows[0] ? rowToTrace(rows[0]) : null
}

async function listTraces(Db: Pool, Limit: number): Promise<Trace[]> {
  const { rows } = await Db.query(`SELECT * FROM traces ORDER BY started_at DESC LIMIT $1`, [Limit])
  return rows.map(rowToTrace)
}

function rowToTrace(r: any): Trace {
  return {
    trace_id: r.trace_id,
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
    created_at: iso(r.created_at)!,
  }
}

// Date → ISO string; null → null。pg 读回的 timestamptz 是 Date 实例，这一位不许越过本层
function iso(v: Date | string | null): string | null {
  if (v === null) return null
  return v instanceof Date ? v.toISOString() : v
}
