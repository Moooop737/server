/**
 * 端点观测壳 —— 每个业务请求一行 traces：入口写 running，出口补耗时/状态/错误码/payloads，响应头带 X-Trace-Id。
 * 跳过：/health*、/traces*、/observability*、/doc*，以及没有匹配到 handler 的路径（末条路由是 `/*`，没有模板可记）。
 * route 取实际执行的那条路由模板（跳过 ALL 中间件；同形模式并存时取先命中的那条）；hono-crud 的 OpenAPI 路由没有 GET_MATCH_RESULT，退回实际 path 并把 UUID 段归一成 :id。
 * payloads 规则：失败（>=400）request/response 两侧都记；成功只给 POST /sessions、PATCH /sessions/:id、POST /resources 记 request。
 *   POST /resources 只留元数据（url/content_type/title/chunker/content_length），content 正文一律不落。
 *   /chat、/retrieve 永不记 payloads（chat 归 Langfuse，retrieve 归 trace_stages）。
 *   body 单侧上限 3KB，超出/非 JSON 只留 omitted 标记；headers 只记白名单，Key/Cookie 等永不落库。
 * 出口：>=400 记 error 并尽量从 JSON 错误体取 code 写 error_code；SSE 的错误体不是 JSON，readResponseBody 会跳过、不消费流。
 *   SSE 到响应头通常只有 200，先写 ok 占位，流结束/中断后的最终值由 /chat 的 onEnd 覆盖同一行（4xx 建流照常记 error）。
 * trace 写失败不影响业务：只记 E_TRACE_WRITE，不把 500 冒给客户端。
 * 单位：duration_ms 为毫秒整数；时间一律 ISO 8601 字符串。
 */

export { createEndpointTrace }

import { randomUUID } from 'node:crypto'
import { matchedRoutes } from 'hono/route'
import { logError, runWithTrace } from './log'

import type { MiddlewareHandler } from 'hono'
import type { Repo, TracePayloadOmitReason, TracePayloads } from '../../adapter/contract'

const MAX_BODY_BYTES = 3072
const REQUEST_HEADERS = ['content-type', 'content-length', 'accept', 'user-agent', 'origin']
const RESPONSE_HEADERS = ['content-type', 'content-length', 'cache-control']
const SECRET_HEADER = /key|token|secret|auth|cookie/i
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

const SUCCESS_REQUEST: Record<string, 'full' | 'resource-meta'> = {
  'POST /sessions': 'full',
  'PATCH /sessions/:id': 'full',
  'POST /resources': 'resource-meta',
}
const NO_PAYLOADS = new Set(['POST /chat', 'POST /retrieve'])
const SKIP_PREFIXES = ['/health', '/traces','/trace', '/observability', '/doc']

type RequestBodyMode = 'full' | 'resource-meta'

interface CapturePlan {
  requestBody: RequestBodyMode
  onSuccess: boolean
}

interface OmittedBody {
  reason: TracePayloadOmitReason
  bytes: number
}

interface RequestBodyInfo {
  body?: unknown
  omitted?: OmittedBody
}

interface ResponseBodyInfo {
  body?: unknown
  code: string | null
  omitted?: OmittedBody
}

function createEndpointTrace(Writer: Pick<Repo, 'insertTrace' | 'finishTrace'>): MiddlewareHandler {
  return async (c, next) => {
    if (SKIP_PREFIXES.some((Prefix) => c.req.path === Prefix || c.req.path.startsWith(Prefix + '/'))) return next()
    // hono-crud 的 OpenAPI 路由没有 GET_MATCH_RESULT；退回实际 path，别把请求打 500
    let Route = c.req.path
    try {
      const Concrete = matchedRoutes(c).find((R) => R.method !== 'ALL')
      if (!Concrete) return next()
      Route = Concrete.path
    } catch {
      Route = c.req.path
    }
    if (Route === '/*' || Route === '') return next()
    Route = Route.replace(UUID, ':id')

    const Plan = capturePlan(c.req.method, Route)
    const RequestClone = Plan && hasJsonBody(c.req.raw) ? c.req.raw.clone() : null
    const TraceId = randomUUID()
    const StartedMs = Date.now()

    return runWithTrace(TraceId, async () => {
      try {
        await Writer.insertTrace({
          id: TraceId,
          route: `${c.req.method} ${Route}`,
          started_at: new Date(StartedMs).toISOString(),
        })
      } catch (err) {
        logError('E_TRACE_WRITE', `写入 trace 失败: ${String(err)}`)
      }

      await next()
      const Res = c.res
      Res.headers.set('X-Trace-Id', TraceId)
      await closeTrace(Writer, TraceId, Res, StartedMs, c.req.raw.headers, RequestClone, Plan)
    })
  }
}

async function closeTrace(
  Writer: Pick<Repo, 'finishTrace'>,
  TraceId: string,
  Res: Response,
  StartedMs: number,
  RequestHeaders: Headers,
  RequestClone: Request | null,
  Plan: CapturePlan | null,
): Promise<void> {
  const EndedMs = Date.now()
  const IsFailure = Res.status >= 400
  const ResponseInfo = IsFailure ? await readResponseBody(Res) : null
  const Capture = Plan !== null && (IsFailure || Plan.onSuccess)
  const Payloads = Capture
    ? await buildPayloads(RequestHeaders, Res.headers, RequestClone, Plan.requestBody, IsFailure, ResponseInfo)
    : null

  try {
    await Writer.finishTrace(TraceId, {
      ended_at: new Date(EndedMs).toISOString(),
      duration_ms: EndedMs - StartedMs,
      http_status: Res.status,
      status: IsFailure ? 'error' : 'ok',
      error_code: ResponseInfo?.code ?? null,
      payloads: Payloads,
    })
  } catch (err) {
    logError('E_TRACE_WRITE', `更新 trace 失败: ${String(err)}`)
  }
}

async function buildPayloads(
  RequestHeaders: Headers,
  ResponseHeaders: Headers,
  RequestClone: Request | null,
  RequestBodyMode: RequestBodyMode,
  IsFailure: boolean,
  ResponseInfo: ResponseBodyInfo | null,
): Promise<TracePayloads> {
  const Payloads: TracePayloads = {}
  const RequestPayload: NonNullable<TracePayloads['request']> = {}
  const RequestHeaderSubset = pickHeaders(RequestHeaders, REQUEST_HEADERS)
  if (RequestHeaderSubset) RequestPayload.headers = RequestHeaderSubset

  if (RequestClone) {
    const Body = await readRequestBody(RequestClone, RequestBodyMode)
    if (Body.body !== undefined) RequestPayload.body = Body.body
    if (Body.omitted) addOmitted(Payloads, 'request_body', Body.omitted)
  }
  Payloads.request = RequestPayload

  if (IsFailure) {
    const ResponsePayload: NonNullable<TracePayloads['response']> = {}
    const ResponseHeaderSubset = pickHeaders(ResponseHeaders, RESPONSE_HEADERS)
    if (ResponseHeaderSubset) ResponsePayload.headers = ResponseHeaderSubset
    if (ResponseInfo?.body !== undefined) ResponsePayload.body = ResponseInfo.body
    if (ResponseInfo?.omitted) addOmitted(Payloads, 'response_body', ResponseInfo.omitted)
    Payloads.response = ResponsePayload
  }

  return Payloads
}

function capturePlan(Method: string, Route: string): CapturePlan | null {
  const Key = `${Method} ${Route}`
  if (NO_PAYLOADS.has(Key)) return null
  const SuccessMode = SUCCESS_REQUEST[Key]
  return SuccessMode === undefined
    ? { requestBody: 'full', onSuccess: false }
    : { requestBody: SuccessMode, onSuccess: true }
}

function hasJsonBody(Request: Request): boolean {
  return Request.body !== null && (Request.headers.get('content-type') ?? '').includes('application/json')
}

async function readRequestBody(Clone: Request, Mode: RequestBodyMode): Promise<RequestBodyInfo> {
  let Text: string
  try {
    Text = await Clone.text()
  } catch {
    return { omitted: { reason: 'not_json', bytes: 0 } }
  }
  const Bytes = Buffer.byteLength(Text, 'utf8')
  if (Mode === 'full' && Bytes > MAX_BODY_BYTES) return { omitted: { reason: 'too_large', bytes: Bytes } }

  let Parsed: unknown
  try {
    Parsed = JSON.parse(Text)
  } catch {
    return { omitted: { reason: 'not_json', bytes: Bytes } }
  }
  if (Mode === 'full') return { body: Parsed }

  const Record = (Parsed !== null && typeof Parsed === 'object' ? Parsed : {}) as Record<string, unknown>
  const Content = typeof Record.content === 'string' ? Record.content : undefined
  const Meta = {
    ...(typeof Record.url === 'string' ? { url: Record.url } : {}),
    ...(typeof Record.content_type === 'string' ? { content_type: Record.content_type } : {}),
    ...(typeof Record.title === 'string' ? { title: Record.title } : {}),
    ...(typeof Record.chunker === 'string' ? { chunker: Record.chunker } : {}),
    content_length: Content === undefined ? 0 : Buffer.byteLength(Content, 'utf8'),
  }
  if (Buffer.byteLength(JSON.stringify(Meta), 'utf8') > MAX_BODY_BYTES) {
    return { omitted: { reason: 'too_large', bytes: Buffer.byteLength(JSON.stringify(Meta), 'utf8') } }
  }
  return Content === undefined
    ? { body: Meta }
    : { body: Meta, omitted: { reason: 'policy', bytes: Buffer.byteLength(Content, 'utf8') } }
}

async function readResponseBody(Res: Response): Promise<ResponseBodyInfo> {
  if (!Res.headers.get('content-type')?.includes('application/json')) return { code: null }
  let Text: string
  try {
    Text = await Res.clone().text()
  } catch {
    return { code: null, omitted: { reason: 'not_json', bytes: 0 } }
  }
  const Bytes = Buffer.byteLength(Text, 'utf8')
  try {
    const Parsed = JSON.parse(Text) as { code?: unknown }
    const Code = typeof Parsed.code === 'string' ? Parsed.code : null
    return Bytes > MAX_BODY_BYTES
      ? { code: Code, omitted: { reason: 'too_large', bytes: Bytes } }
      : { code: Code, body: Parsed }
  } catch {
    return { code: null, omitted: { reason: 'not_json', bytes: Bytes } }
  }
}

function pickHeaders(Source: Headers, Names: string[]): Record<string, string> | undefined {
  const Picked: Record<string, string> = {}
  for (const Name of Names) {
    if (SECRET_HEADER.test(Name)) continue
    const Value = Source.get(Name)
    if (Value !== null) Picked[Name] = Value
  }
  return Object.keys(Picked).length > 0 ? Picked : undefined
}

function addOmitted(Payloads: TracePayloads, Key: 'request_body' | 'response_body', Omitted: OmittedBody): void {
  Payloads.omitted ??= {}
  Payloads.omitted[Key] = Omitted
}
