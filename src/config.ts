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

  const dimsRaw = get('EMBEDDING_DIMENSIONS')
  // 仅表示向当前 embedder 请求的输出维度（AD-4：存储不设维度上限，启动期不做合法性卡口）
  const embeddingDimensions = dimsRaw ? Number(dimsRaw) : 1024

  const portRaw = get('PORT')
  const port = portRaw ? Number(portRaw) : 3000

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
