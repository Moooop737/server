/**
 * Langfuse 读侧 —— 只读 /api/public/v2/observations；v3 里 GET /api/public/traces/{id} 已移除，这是实时读路径。
 * 一条本地 trace_id 在库里存着 langfuse_trace_id；调用方先读库再拿它来查，观测内容不落本库。
 * 请求用 Basic(public:secret)，账号只在本文件里从 env 读，不打印、不交给调用方。
 * fields 一次拿全：core/basic/time/io/metadata/model/usage/metrics/trace_context；input/output 是原始字符串，这里尽量解析成 JSON。
 * tool 调用的 toolCallId 在 metadata['attributes.gen_ai.tool.call.id']，取出来给前端对 tool part。
 * 8s 超时；401/403、429、网络/超时、形状不符分别给稳定 code，由路由映射成 HTTP 状态。
 * 分页按 meta.cursor 走，最多 10 页（1000/页）；超过就截断并标 Truncated，不静默。
 */

export { readLangfuseObservations, langfuseReady, LangfuseReadError }
export type { LangfuseObservation, LangfuseTraceRead }

import type { ContentfulStatusCode } from 'hono/utils/http-status'

const FIELDS = 'core,basic,time,io,metadata,model,usage,metrics,trace_context'
const PAGE_LIMIT = 1000
const MAX_PAGES = 10
const TIMEOUT_MS = 8000

interface LangfuseObservation {
  id: string
  traceId: string
  parentObservationId: string | null
  type: string
  name: string | null
  startTime: string
  endTime: string | null
  latency: number | null
  timeToFirstToken: number | null
  model: string | null
  level: string | null
  statusMessage: string | null
  isRootObservation: boolean
  input: unknown
  output: unknown
  usageDetails: Record<string, number> | null
  totalCost: number | null
  tags: string[]
  traceName: string | null
  toolCallId: string | null
}

interface LangfuseTraceRead {
  Observations: LangfuseObservation[]
  Truncated: boolean
}

class LangfuseReadError extends Error {
  readonly code: string
  readonly status: ContentfulStatusCode

  constructor(Code: string, Message: string, Status: ContentfulStatusCode) {
    super(Message)
    this.name = 'LangfuseReadError'
    this.code = Code
    this.status = Status
  }
}

function langfuseReady(): boolean {
  return Boolean(
    process.env.LANGFUSE_BASE_URL?.trim() &&
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  )
}

async function readLangfuseObservations(TraceId: string): Promise<LangfuseTraceRead> {
  if (!langfuseReady()) throw new LangfuseReadError('E_LANGFUSE_DISABLED', 'Langfuse 未配置', 503)
  const BaseUrl = process.env.LANGFUSE_BASE_URL!.trim().replace(/\/+$/, '')
  const Auth = `Basic ${Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY!.trim()}:${process.env.LANGFUSE_SECRET_KEY!.trim()}`).toString('base64')}`
  const Observations: LangfuseObservation[] = []
  let Cursor: string | undefined
  let Truncated = false
  let Seen = 0
  const Deadline = Date.now() + 12_000

  for (let Page = 0; Page < MAX_PAGES; Page += 1) {
    const Remaining = Deadline - Date.now()
    if (Remaining <= 0) {
      Truncated = true
      break
    }
    const Url = new URL(`${BaseUrl}/api/public/v2/observations`)
    Url.searchParams.set('traceId', TraceId)
    Url.searchParams.set('fields', FIELDS)
    Url.searchParams.set('limit', String(PAGE_LIMIT))
    if (Cursor !== undefined) Url.searchParams.set('cursor', Cursor)

    const Res = await request(Url, Auth, Math.min(TIMEOUT_MS, Remaining))
    const Body = await parseBody(Res)
    const Data = Array.isArray(Body.data) ? Body.data : null
    if (Data === null) throw new LangfuseReadError('E_LANGFUSE_SHAPE', 'Langfuse 返回形状不符合契约', 502)
    Seen += Data.length
    for (const Row of Data) {
      const Observation = normalizeObservation(Row)
      if (Observation !== null) Observations.push(Observation)
    }

    const Meta = Body.meta !== null && typeof Body.meta === 'object' ? (Body.meta as Record<string, unknown>) : {}
    Cursor = typeof Meta.cursor === 'string' && Meta.cursor !== '' ? Meta.cursor : undefined
    if (Cursor === undefined) break
    if (Page === MAX_PAGES - 1) Truncated = true
  }

  if (Seen > 0 && Observations.length === 0) {
    throw new LangfuseReadError('E_LANGFUSE_SHAPE', 'Langfuse 观测全量解析失败', 502)
  }
  return { Observations, Truncated }
}

async function request(Url: URL, Auth: string, TimeoutMs: number): Promise<Response> {
  let Res: Response
  try {
    Res = await fetch(Url, {
      headers: { Authorization: Auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(TimeoutMs),
    })
  } catch (err) {
    throw new LangfuseReadError('E_LANGFUSE_UNAVAILABLE', `Langfuse 不可达或超时: ${err instanceof Error ? err.name : 'unknown'}`, 503)
  }
  if (Res.ok) return Res
  if (Res.status === 401 || Res.status === 403) {
    throw new LangfuseReadError('E_LANGFUSE_AUTH', 'Langfuse 鉴权失败', 502)
  }
  if (Res.status === 429) {
    throw new LangfuseReadError('E_LANGFUSE_RATE_LIMIT', 'Langfuse 限流，稍后再试', 503)
  }
  throw new LangfuseReadError('E_LANGFUSE_READ', `Langfuse 读取失败（HTTP ${Res.status}）`, 502)
}

async function parseBody(Res: Response): Promise<Record<string, unknown>> {
  try {
    const Body = (await Res.json()) as unknown
    return Body !== null && typeof Body === 'object' ? (Body as Record<string, unknown>) : {}
  } catch {
    throw new LangfuseReadError('E_LANGFUSE_SHAPE', 'Langfuse 返回不是 JSON', 502)
  }
}

function normalizeObservation(Value: unknown): LangfuseObservation | null {
  if (Value === null || typeof Value !== 'object') return null
  const Row = Value as Record<string, unknown>
  if (typeof Row.id !== 'string' || typeof Row.startTime !== 'string' || typeof Row.type !== 'string') return null
  const Metadata = Row.metadata !== null && typeof Row.metadata === 'object' && !Array.isArray(Row.metadata)
    ? Row.metadata as Record<string, unknown>
    : null
  const ToolCallId = Metadata?.['attributes.gen_ai.tool.call.id']
  return {
    id: Row.id,
    traceId: typeof Row.traceId === 'string' ? Row.traceId : '',
    parentObservationId: typeof Row.parentObservationId === 'string' ? Row.parentObservationId : null,
    type: Row.type,
    name: typeof Row.name === 'string' && Row.name !== '' ? Row.name : null,
    startTime: Row.startTime,
    endTime: typeof Row.endTime === 'string' ? Row.endTime : null,
    latency: numberOrNull(Row.latency),
    timeToFirstToken: numberOrNull(Row.timeToFirstToken),
    model: typeof Row.model === 'string' && Row.model !== '' ? Row.model : null,
    level: typeof Row.level === 'string' ? Row.level : null,
    statusMessage: typeof Row.statusMessage === 'string' ? Row.statusMessage : null,
    isRootObservation: Row.isRootObservation === true,
    input: parseIo(Row.input),
    output: parseIo(Row.output),
    usageDetails: numberRecord(Row.usageDetails),
    totalCost: numberOrNull(Row.totalCost),
    tags: stringArray(Row.tags),
    traceName: typeof Row.traceName === 'string' ? Row.traceName : null,
    toolCallId: typeof ToolCallId === 'string' && ToolCallId !== '' ? ToolCallId : null,
  }
}

function parseIo(Value: unknown): unknown {
  if (Value === null || Value === undefined) return null
  if (typeof Value !== 'string') return Value
  const Trimmed = Value.trim()
  if (Trimmed === '') return null
  try {
    return JSON.parse(Trimmed)
  } catch {
    return Value
  }
}

function numberOrNull(Value: unknown): number | null {
  return typeof Value === 'number' && Number.isFinite(Value) ? Value : null
}

function numberRecord(Value: unknown): Record<string, number> | null {
  if (Value === null || typeof Value !== 'object' || Array.isArray(Value)) return null
  const Entries = Object.entries(Value as Record<string, unknown>).filter(
    (Entry): Entry is [string, number] => typeof Entry[1] === 'number' && Number.isFinite(Entry[1]),
  )
  return Entries.length > 0 ? Object.fromEntries(Entries) : null
}

function stringArray(Value: unknown): string[] {
  return Array.isArray(Value) ? Value.filter((Item): Item is string => typeof Item === 'string') : []
}
