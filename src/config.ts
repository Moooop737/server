/**
 * 配置装载 —— 从 process.env 读并校验，缺必需项/非法值 fail-fast（抛 ConfigError，由入口转 exit）。
 * loadConfig() 是唯一入口；numOrThrow() 是整数型 env 的解析 + 范围校验工具。
 * embeddingDimensions 非 1024 不阻断、仅 warn：P1 只建 1024 档 partial HNSW，其它维度检索退顺序扫描（结果仍对、只是慢）。见 addendum A / AD-4。
 * CHAT_PROVIDER 仅支持 deepseek | dashscope；host 固定 127.0.0.1（AD-8 仅本地监听）。
 */

export { loadConfig }

export interface AppConfig {
  host: string
  port: number
  databaseUrl: string
  ollamaBaseUrl: string
  embeddingModel: string
  embeddingDimensions: number
  chatProvider: 'deepseek' | 'dashscope'
  chatApiKey: string
}

export class ConfigError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
  }
}

const CHAT_KEY_BY_PROVIDER = {
  deepseek: 'DEEPSEEK_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
} as const

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

  const providerRaw = (get('CHAT_PROVIDER') ?? 'deepseek').toLowerCase()
  if (providerRaw !== 'deepseek' && providerRaw !== 'dashscope') {
    throw new ConfigError('E_CONFIG_INVALID', `CHAT_PROVIDER 只支持 deepseek | dashscope，收到: ${providerRaw}`)
  }
  const chatProvider = providerRaw as 'deepseek' | 'dashscope'
  const chatKeyEnv = CHAT_KEY_BY_PROVIDER[chatProvider]
  const chatApiKey = get(chatKeyEnv)
  if (!chatApiKey) missing.push(chatKeyEnv)

  if (missing.length > 0) {
    throw new ConfigError('E_CONFIG_MISSING', `必需的环境变量缺失: ${missing.join(', ')}`)
  }

  const embeddingDimensions = numOrThrow(get('EMBEDDING_DIMENSIONS'), 'EMBEDDING_DIMENSIONS', 1024, 1, 16000)
  if (embeddingDimensions !== 1024) {
    console.warn(JSON.stringify({ code: 'W_EMBEDDING_DIM', message: `EMBEDDING_DIMENSIONS=${embeddingDimensions} 无对应 HNSW 索引，检索将退化顺序扫描` }))
  }

  const port = numOrThrow(get('PORT'), 'PORT', 3000, 1, 65535)

  return {
    host: '127.0.0.1',
    port,
    databaseUrl: databaseUrl!,
    ollamaBaseUrl: ollamaBaseUrl!,
    embeddingModel: embeddingModel!,
    embeddingDimensions,
    chatProvider,
    chatApiKey: chatApiKey!,
  }
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
