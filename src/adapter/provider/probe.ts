/**
 * provider 探测 —— 连接测试与模型发现的上游 HTTP 调用，只做 GET 列表，不发生成请求。
 * 5s 超时；不跟随重定向；响应上限 1MB；错误只回状态码与短消息，不回上游 body。
 * 本文件不读 DB / env：target 由调用方组装；也不解密，Key 已在 target 里。
 */

export { probeProvider, discoverProvider, ProbeError }
export type { ProbeTarget, ProbeResult, DiscoveredModel, DiscoverResult }

import type { ProviderKind } from '../repo/config'

const TIMEOUT_MS = 5000
const MAX_BODY_CHARS = 1_000_000

interface ProbeTarget {
  kind: ProviderKind
  base_url: string | null
  api_key: string | null
  headers: Record<string, string>
  query: Record<string, string>
}

interface ProbeResult {
  ok: boolean
  status?: number
  latency_ms: number
  model_count?: number
  message?: string
}

interface DiscoveredModel {
  model_id: string
  owned_by: string | null
  created: number | null
}

interface DiscoverResult {
  fetched_at: string
  source: 'openai-models' | 'ollama-tags'
  models: DiscoveredModel[]
}

class ProbeError extends Error {
  readonly code: string
  readonly status: number | null

  constructor(Code: string, Message: string, Status: number | null = null) {
    super(Message)
    this.name = 'ProbeError'
    this.code = Code
    this.status = Status
  }
}

async function probeProvider(Target: ProbeTarget): Promise<ProbeResult> {
  const Started = Date.now()
  try {
    const Catalog = await fetchCatalog(Target)
    return {
      ok: true,
      status: Catalog.status,
      latency_ms: Date.now() - Started,
      model_count: Catalog.models.length,
    }
  } catch (Err) {
    if (Err instanceof ProbeError) {
      return {
        ok: false,
        latency_ms: Date.now() - Started,
        message: Err.message,
        ...(Err.status === null ? {} : { status: Err.status }),
      }
    }
    return {
      ok: false,
      latency_ms: Date.now() - Started,
      message: isTimeout(Err) ? '超时' : '连接失败',
    }
  }
}

async function discoverProvider(Target: ProbeTarget): Promise<DiscoverResult> {
  const Catalog = await fetchCatalog(Target)
  return {
    fetched_at: new Date().toISOString(),
    source: Catalog.source,
    models: Catalog.models,
  }
}

async function fetchCatalog(Target: ProbeTarget): Promise<{
  source: DiscoverResult['source']
  models: DiscoveredModel[]
  status: number
}> {
  const Primary = catalogEndpoint(Target)
  try {
    return await fetchCatalogOnce(Target, Primary.url, Primary.source, Primary.parse)
  } catch (Err) {
    if (Target.kind !== 'ollama' || !(Err instanceof ProbeError) || Err.status !== 404) throw Err
    return fetchCatalogOnce(
      Target,
      endpointUrl(ollamaRoot(Target.base_url!), '/api/tags'),
      'ollama-tags',
      ollamaModels,
    )
  }
}

async function fetchCatalogOnce(
  Target: ProbeTarget,
  InputUrl: URL,
  Source: DiscoverResult['source'],
  Parse: (Body: unknown) => DiscoveredModel[],
): Promise<{
  source: DiscoverResult['source']
  models: DiscoveredModel[]
  status: number
}> {
  const Url = new URL(InputUrl.toString())
  for (const [Key, Value] of Object.entries(Target.query)) Url.searchParams.set(Key, Value)

  const Headers: Record<string, string> = {}
  if (Target.api_key !== null) Headers.Authorization = `Bearer ${Target.api_key}`
  for (const [Key, Value] of Object.entries(Target.headers)) Headers[Key] = Value

  let Res: Response
  try {
    Res = await fetch(Url, {
      method: 'GET',
      headers: Headers,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (Err) {
    if (isTimeout(Err)) throw new ProbeError('E_PROVIDER_TIMEOUT', '超时')
    throw new ProbeError('E_PROVIDER_CONNECT', '连接失败')
  }

  if (!Res.ok) {
    throw new ProbeError(probeCode(Res.status), messageOf(Res.status), Res.status)
  }

  let Text: string
  try {
    Text = await Res.text()
  } catch (Err) {
    if (isTimeout(Err)) throw new ProbeError('E_PROVIDER_TIMEOUT', '超时')
    throw new ProbeError('E_PROVIDER_CONNECT', '连接失败')
  }
  if (Text.length > MAX_BODY_CHARS) {
    throw new ProbeError('E_PROVIDER_TOO_LARGE', '上游响应过大', Res.status)
  }

  let Body: unknown
  try {
    Body = JSON.parse(Text)
  } catch {
    throw new ProbeError('E_PROVIDER_BAD_JSON', '上游返回不是 JSON', Res.status)
  }

  return { source: Source, models: Parse(Body), status: Res.status }
}

function catalogEndpoint(Target: ProbeTarget): {
  url: URL
  source: DiscoverResult['source']
  parse: (Body: unknown) => DiscoveredModel[]
} {
  if (Target.kind === 'deepseek') {
    return { url: endpointUrl(Target.base_url ?? 'https://api.deepseek.com', '/models'), source: 'openai-models', parse: openaiModels }
  }
  if (Target.kind === 'dashscope') {
    return {
      url: endpointUrl(Target.base_url ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1', '/models'),
      source: 'openai-models',
      parse: openaiModels,
    }
  }
  if (Target.kind === 'ollama') {
    if (Target.base_url === null) throw new ProbeError('E_PROVIDER_BAD_TARGET', 'ollama 缺少 base_url')
    return { url: endpointUrl(ollamaRoot(Target.base_url), '/v1/models'), source: 'openai-models', parse: openaiModels }
  }
  if (Target.base_url === null) throw new ProbeError('E_PROVIDER_BAD_TARGET', '缺少 base_url')
  return { url: endpointUrl(Target.base_url, '/models'), source: 'openai-models', parse: openaiModels }
}

function ollamaRoot(Base: string): string {
  return Base.replace(/\/+$/, '').replace(/\/v1$/, '')
}

function endpointUrl(Base: string, Path: string): URL {
  return new URL(`${Base.replace(/\/+$/, '')}${Path}`)
}

function openaiModels(Body: unknown): DiscoveredModel[] {
  if (Body === null || typeof Body !== 'object') {
    throw new ProbeError('E_PROVIDER_BAD_SHAPE', '上游清单形状不合法')
  }
  const Data = (Body as { data?: unknown }).data
  if (!Array.isArray(Data)) throw new ProbeError('E_PROVIDER_BAD_SHAPE', '上游清单缺少 data')
  return Data.flatMap((Item) => {
    if (Item === null || typeof Item !== 'object') return []
    const Row = Item as { id?: unknown; owned_by?: unknown; created?: unknown }
    if (typeof Row.id !== 'string' || Row.id.trim() === '') return []
    return [{
      model_id: Row.id,
      owned_by: typeof Row.owned_by === 'string' ? Row.owned_by : null,
      created: typeof Row.created === 'number' ? Row.created : null,
    }]
  })
}

function ollamaModels(Body: unknown): DiscoveredModel[] {
  if (Body === null || typeof Body !== 'object') {
    throw new ProbeError('E_PROVIDER_BAD_SHAPE', '上游清单形状不合法')
  }
  const Rows = (Body as { models?: unknown }).models
  if (!Array.isArray(Rows)) throw new ProbeError('E_PROVIDER_BAD_SHAPE', '上游清单缺少 models')
  return Rows.flatMap((Item) => {
    if (Item === null || typeof Item !== 'object') return []
    const Row = Item as { name?: unknown }
    if (typeof Row.name !== 'string' || Row.name.trim() === '') return []
    return [{ model_id: Row.name, owned_by: null, created: null }]
  })
}

function probeCode(Status: number): string {
  if (Status === 401 || Status === 403) return 'E_PROVIDER_AUTH'
  if (Status === 404) return 'E_PROVIDER_NOT_FOUND'
  return 'E_PROVIDER_UPSTREAM'
}

function messageOf(Status: number): string {
  if (Status === 401 || Status === 403) return `鉴权失败 (${Status})`
  if (Status === 404) return `接口不存在 (${Status})`
  return `上游返回 ${Status}`
}

function isTimeout(Err: unknown): boolean {
  return Err instanceof Error && (Err.name === 'TimeoutError' || Err.name === 'AbortError')
}
