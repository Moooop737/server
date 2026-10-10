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

// 解析整数型 env：缺省取 def；有值但非整数或越界则在启动期点名报错（延续 fail-fast，不让 NaN 溜到 listen）
function numOrThrow(
  raw: string | undefined,
  name: string,
  def: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return def
  const v = Number(raw)
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new ConfigError('E_CONFIG_INVALID', `${name} 需为 ${min}-${max} 的整数，收到: ${raw}`)
  }
  return v
}

// 从 process.env 读取并校验配置；缺必需项在启动阶段即抛错（fail-fast，FR-12/AD-8）
export function loadConfig(): AppConfig {
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
  // AD-4：存储不设维度上限，启动期不做“必须 1024”卡口；但 P1 只建了 1024 那一档的 partial HNSW，
  // 其他维度无索引→检索会静默退化顺序扫描（结果仍对、只是慢），故提醒一句。
  if (embeddingDimensions !== 1024) {
    console.warn(JSON.stringify({ code: 'W_EMBEDDING_DIM', message: `EMBEDDING_DIMENSIONS=${embeddingDimensions} 无对应 HNSW 索引，检索将退化顺序扫描` }))
  }

  const port = numOrThrow(get('PORT'), 'PORT', 3000, 1, 65535)

  return {
    host: '127.0.0.1', // AD-8：仅本地监听
    port,
    databaseUrl: databaseUrl!,
    ollamaBaseUrl: ollamaBaseUrl!,
    embeddingModel: embeddingModel!,
    embeddingDimensions,
    chatProvider,
    chatApiKey: chatApiKey!,
  }
}
