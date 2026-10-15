/**
 * Ollama 本地服务的只读适配层：探测服务可达性与模型状态，不涉及生成。
 * 字段依 Ollama 官方响应原样建模，均为 snake_case。
 *
 * - ollamaHealthCheck：GET /api/version，只判服务在线与否；网络/超时异常吞掉并返回 false。
 * - ollamaModelList：GET /api/tags，返回本地已下载的全部模型；非 2xx 抛错。
 * - ollamaStatusList：GET /api/ps，返回当前驻留内存的模型（含过期时间与显存占用）；非 2xx 抛错。
 * - size / size_vram 单位均为字节。
 */

export { ollamaHealthCheck, ollamaModelList, ollamaStatusList }
export type { OllamaModelDetails, OllamaModelEntry, OllamaModelStatus }

async function ollamaHealthCheck(BaseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${BaseUrl}/api/version`, {
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

interface OllamaModelDetails {
  parent_model: string
  format: string
  family: string
  families: string[]
  parameter_size: string
  quantization_level: string
}

interface OllamaModelEntry {
  name: string
  model: string
  modified_at: string
  size: number // bytes
  digest: string
  details: OllamaModelDetails
}

async function ollamaModelList(BaseUrl: string): Promise<OllamaModelEntry[]> {
  const res = await fetch(`${BaseUrl}/api/tags`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`ollamaModelList HTTP ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { models?: OllamaModelEntry[] }
  return json.models ?? []
}

interface OllamaModelStatus {
  name: string
  model: string
  size: number // bytes
  digest: string
  details: OllamaModelDetails
  expires_at: string
  size_vram: number // bytes
}

async function ollamaStatusList(BaseUrl: string): Promise<OllamaModelStatus[]> {
  const res = await fetch(`${BaseUrl}/api/ps`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`ollamaStatusList HTTP ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { models?: OllamaModelStatus[] }
  return json.models ?? []
}
