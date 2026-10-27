/**
 * 配置装载 —— 从 process.env 读并校验，缺必需项/非法值当场打印结构化 JSON 并 process.exit(1)。
 * 打印与终止都住在本文件：AppConfig 是 @singleton() 类，谁第一个把它叫起来都一样 —— 不依赖调用顺序，也不再包一层 root 侧的 try/catch。
 * 代价说清：这条错误路径**不可被 catch**，要在测试里断「缺 DATABASE_URL 报 E_CONFIG_MISSING」只能开子进程看退出码与 stdout。
 * numOrThrow() 是整数型 env 的解析 + 范围校验工具，floatOrThrow() 管小数（检索阈值）；两者都在构造器里用。
 * embeddingDimensions 非 1024 不阻断、仅 warn：P1 只建 1024 档 partial HNSW，其它维度检索退顺序扫描（结果仍对、只是慢）。见 addendum A / AD-4。
 * CHAT_MODEL 与另外三个是必需项（缺失走 E_CONFIG_MISSING），但本文件不校验它在不在 model 清单里——那由 ChatHandle 的构造点名（E_CHAT_MODEL）；服务商与它的 Key 归 adapter/provider 登记表，本文件不再认 CHAT_PROVIDER。host 固定 127.0.0.1（AD-8 仅本地监听）。
 * S3_* 是对象存储必需项；S3_ENDPOINT 必须等于浏览器访问 MinIO 的 Host（presign 的 Host 会被签进 URL），末尾斜杠会被去掉；S3_REGION 默认 us-east-1，S3_FORCE_PATH_STYLE 默认 true。密钥只进 AppConfig，不打印、不进错误信息。
 */

import 'reflect-metadata'
import { singleton } from 'tsyringe'
import type { CodebaseRepo, Repo } from './adapter/contract';
import { logInfo, logWarn, logError } from './trace/systemtrace/log'

export { AppConfig, getEnv, cleanUpOnBoot }

@singleton()
class AppConfig {
  readonly host = '127.0.0.1'
  readonly port: number
  readonly databaseUrl: string
  readonly ollamaBaseUrl: string
  readonly embeddingModel: string
  readonly embeddingDimensions: number
  readonly chatModel: string
  readonly retrievalVectorTopK: number
  readonly retrievalLexicalTopK: number
  readonly retrievalMinSimilarity: number   // 余弦相似度下限
  readonly retrievalRrfK: number            // RRF 的 k，标准取 60
  readonly retrievalDefaultLimit: number    // 融合后送进上下文的条数
  readonly s3Endpoint: string
  readonly s3Region: string
  readonly s3Bucket: string
  readonly s3AccessKeyId: string
  readonly s3SecretAccessKey: string
  readonly s3ForcePathStyle: boolean

  constructor() {
    const missing: string[] = []
    const embeddingModel = getEnv('EMBEDDING_MODEL', missing)
    const chatModel = getEnv('CHAT_MODEL', missing)
    const databaseUrl = getEnv('DATABASE_URL', missing)
    const ollamaBaseUrl = getEnv('OLLAMA_BASE_URL', missing)
    const s3EndpointRaw = getEnv('S3_ENDPOINT', missing)
    const s3Bucket = getEnv('S3_BUCKET', missing)
    const s3AccessKeyId = getEnv('S3_ACCESS_KEY_ID', missing)
    const s3SecretAccessKey = getEnv('S3_SECRET_ACCESS_KEY', missing)

    if (missing.length > 0) {
      fail('E_CONFIG_MISSING', `必需的环境变量缺失: ${missing.join(', ')}`)
    }
    this.embeddingModel = embeddingModel!
    this.chatModel = chatModel!
    this.embeddingDimensions = numOrThrow(getEnv('EMBEDDING_DIMENSIONS'), 'EMBEDDING_DIMENSIONS', 1024, 1, 16000)
    if (![2048, 1024, 512].includes(this.embeddingDimensions)) {
      logWarn('W_EMBEDDING_DIM', `EMBEDDING_DIMENSIONS=${this.embeddingDimensions} 无对应 HNSW 索引，检索将退化顺序扫描`)
    }

    this.port = numOrThrow(getEnv('PORT'), 'PORT', 3000, 1, 65535)
    this.databaseUrl = databaseUrl!
    this.ollamaBaseUrl = ollamaBaseUrl!

    this.retrievalVectorTopK = numOrThrow(getEnv('RETRIEVAL_VECTOR_TOPK'), 'RETRIEVAL_VECTOR_TOPK', 10, 1, 100)
    this.retrievalLexicalTopK = numOrThrow(getEnv('RETRIEVAL_LEXICAL_TOPK'), 'RETRIEVAL_LEXICAL_TOPK', 10, 1, 100)
    this.retrievalMinSimilarity = floatOrThrow(getEnv('RETRIEVAL_MIN_SIMILARITY'), 'RETRIEVAL_MIN_SIMILARITY', 0.42, 0, 1)
    this.retrievalRrfK = numOrThrow(getEnv('RETRIEVAL_RRF_K'), 'RETRIEVAL_RRF_K', 60, 1, 1000)
    this.retrievalDefaultLimit = numOrThrow(getEnv('RETRIEVAL_DEFAULT_LIMIT'), 'RETRIEVAL_DEFAULT_LIMIT', 6, 1, 100)

    this.s3Endpoint = endpointOrThrow(s3EndpointRaw!, 'S3_ENDPOINT')
    this.s3Region = getEnv('S3_REGION') ?? 'us-east-1'
    this.s3Bucket = s3Bucket!
    this.s3AccessKeyId = s3AccessKeyId!
    this.s3SecretAccessKey = s3SecretAccessKey!
    this.s3ForcePathStyle = boolOrThrow(getEnv('S3_FORCE_PATH_STYLE'), 'S3_FORCE_PATH_STYLE', true)
  }
}

async function cleanUpOnBoot(repo: Repo, codebases: CodebaseRepo, config: AppConfig) {
  try {
    const cleaned = await repo.markStaleOnBoot()
    if (cleaned.resources > 0 || cleaned.uploads > 0) {
      logInfo('I_BOOT_CLEANUP', `启动清扫：${cleaned.resources} 条 processing→process_failed，${cleaned.uploads} 条 uploading→upload_failed`)
    }
  } catch (err) {
    logError('E_CLEANUP', String(err))
  }

  try {
    const cleaned = await codebases.markStaleCodebases()
    if (cleaned.processing > 0 || cleaned.uploads > 0) {
      logInfo('I_CODEBASE_CLEANUP', `启动清扫：${cleaned.processing} 条 codebase processing→failed，${cleaned.uploads} 条 uploading→failed`)
    }
  } catch (err) {
    logError('E_CODEBASE_CLEANUP', String(err))
  }

  try {
    const stored = await repo.dimensionsInStore()
    logInfo('I_VECTOR_DIMENSIONS', `库中向量维度=${stored.join(',') || '空'} 检索维度=${config.embeddingDimensions}`)
  } catch (err) {
    logError('E_DIMENSION_PROBE', String(err))
  }
}

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
    fail('E_CONFIG_INVALID', `${Name} 需为 ${Min}-${Max} 的数值，收到: ${Raw}`)
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
    fail('E_CONFIG_INVALID', `${Name} 需为 ${Min}-${Max} 的整数，收到: ${Raw}`)
  }
  return v
}

function endpointOrThrow(Raw: string, Name: string): string {
  let parsed: URL
  try {
    parsed = new URL(Raw)
  } catch {
    return fail('E_CONFIG_INVALID', `${Name} 不是合法 URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail('E_CONFIG_INVALID', `${Name} 必须是 http/https`)
  }
  return Raw.replace(/\/+$/, '')
}

function boolOrThrow(Raw: string | undefined, Name: string, Def: boolean): boolean {
  if (Raw === undefined) return Def
  if (Raw === 'true') return true
  if (Raw === 'false') return false
  return fail('E_CONFIG_INVALID', `${Name} 只能是 true/false，收到: ${Raw}`)
}

function fail(code: string, message: string): never {
  logError(code, message)
  process.exit(1)
}

const getEnv = (name: string, missing?: string[]): string | undefined => {
  const v = process.env[name]?.trim()
  if (!v && missing) {
    missing.push(name)
  }
  return v ? v : undefined
}
