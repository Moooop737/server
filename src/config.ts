/**
 * 配置装载 —— 从 process.env 读并校验，缺必需项/非法值 fail-fast（抛 ConfigError，由入口转 exit）。
 * loadConfig() 是唯一入口；numOrThrow() 是整数型 env 的解析 + 范围校验工具，floatOrThrow() 管小数（检索阈值）。
 * embeddingDimensions 非 1024 不阻断、仅 warn：P1 只建 1024 档 partial HNSW，其它维度检索退顺序扫描（结果仍对、只是慢）。见 addendum A / AD-4。
 * CHAT_MODEL 只装载不校验（缺失＝今天不选，填了却不在 model 清单里由 bootstrap 点名退出）；服务商与它的 Key 归 adapter/provider 登记表，本文件不再认 CHAT_PROVIDER。host 固定 127.0.0.1（AD-8 仅本地监听）。
 */

export { loadConfig, getEnv }

export interface AppConfig {
  host: string
  port: number
  databaseUrl: string
  ollamaBaseUrl: string
  embeddingModel: string
  embeddingDimensions: number
  chatModel: string
  retrievalVectorTopK: number
  retrievalLexicalTopK: number
  retrievalMinSimilarity: number
  retrievalRrfK: number
  retrievalDefaultLimit: number
}

export class ConfigError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
  }
}

function loadConfig(): AppConfig {
  const get = (name: string): string | undefined => {
    const v = process.env[name]?.trim()
    return v ? v : undefined
  }

  const missing: string[] = []
  const databaseUrl = get('DATABASE_URL')
  const ollamaBaseUrl = get('OLLAMA_BASE_URL')
  const embeddingModel = get('EMBEDDING_MODEL')
  if (!databaseUrl) missing.push('DATABASE_URL')
  if (!ollamaBaseUrl) missing.push('OLLAMA_BASE_URL')
  if (!embeddingModel) missing.push('EMBEDDING_MODEL')

  const chatModel = get('CHAT_MODEL')!
  if (!chatModel) missing.push('CHAT_MODEL')

  if (missing.length > 0) {
    throw new ConfigError('E_CONFIG_MISSING', `必需的环境变量缺失: ${missing.join(', ')}`)
  }

  const embeddingDimensions = numOrThrow(get('EMBEDDING_DIMENSIONS'), 'EMBEDDING_DIMENSIONS', 1024, 1, 16000)
  if (embeddingDimensions !== 1024) {
    console.warn(JSON.stringify({ code: 'W_EMBEDDING_DIM', message: `EMBEDDING_DIMENSIONS=${embeddingDimensions} 无对应 HNSW 索引，检索将退化顺序扫描` }))
  }

  const port = numOrThrow(get('PORT'), 'PORT', 3000, 1, 65535)

  const retrievalVectorTopK = numOrThrow(get('RETRIEVAL_VECTOR_TOPK'), 'RETRIEVAL_VECTOR_TOPK', 10, 1, 100)
  const retrievalLexicalTopK = numOrThrow(get('RETRIEVAL_LEXICAL_TOPK'), 'RETRIEVAL_LEXICAL_TOPK', 10, 1, 100)
  const retrievalMinSimilarity = floatOrThrow(get('RETRIEVAL_MIN_SIMILARITY'), 'RETRIEVAL_MIN_SIMILARITY', 0.42, 0, 1)
  const retrievalRrfK = numOrThrow(get('RETRIEVAL_RRF_K'), 'RETRIEVAL_RRF_K', 60, 1, 1000)
  const retrievalDefaultLimit = numOrThrow(get('RETRIEVAL_DEFAULT_LIMIT'), 'RETRIEVAL_DEFAULT_LIMIT', 6, 1, 100)

  return {
    host: '127.0.0.1',
    port,
    databaseUrl: databaseUrl!,
    ollamaBaseUrl: ollamaBaseUrl!,
    embeddingModel: embeddingModel!,
    embeddingDimensions,
    chatModel,
    retrievalVectorTopK,
    retrievalLexicalTopK,
    retrievalMinSimilarity,
    retrievalRrfK,
    retrievalDefaultLimit,
  }
}

/** 小数型 env 的解析 + 范围校验；RETRIEVAL_MIN_SIMILARITY 这类阈值不是整数，走这条而非 numOrThrow */
function floatOrThrow(
  Raw: string | undefined,
  Name: string,
  Def: number,
  Min: number,
  Max: number,
): number {
  if (Raw === undefined) return Def
  const v = Number(Raw)
  if (!Number.isFinite(v) || v < Min || v > Max) {
    throw new ConfigError('E_CONFIG_INVALID', `${Name} 需为 ${Min}-${Max} 的数值，收到: ${Raw}`)
  }
  return v
}

function numOrThrow(
  Raw: string | undefined,
  Name: string,
  Def: number,
  Min: number,
  Max: number,
): number {
  if (Raw === undefined) return Def
  const v = Number(Raw)
  if (!Number.isInteger(v) || v < Min || v > Max) {
    throw new ConfigError('E_CONFIG_INVALID', `${Name} 需为 ${Min}-${Max} 的整数，收到: ${Raw}`)
  }
  return v
}

const getEnv = (name: string): string | undefined => {
  const v = process.env[name]?.trim()
  return v ? v : undefined
}