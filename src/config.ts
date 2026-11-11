/**
 * 配置装载 —— 从 process.env 读并校验，缺必需项/非法值当场打印结构化 JSON 并 process.exit(1)。
 * 打印与终止都住在本文件：AppConfig 是 @singleton() 类，谁第一个把它叫起来都一样 —— 不依赖调用顺序，也不再包一层 root 侧的 try/catch。
 * 代价说清：这条错误路径**不可被 catch**，要在测试里断「缺 DATABASE_URL 报 E_CONFIG_MISSING」只能开子进程看退出码与 stdout。
 * numOrThrow() 是整数型 env 的解析 + 范围校验工具；在构造器里用。
 * 模型与供应商不进 env：CHAT_MODEL / EMBEDDING_MODEL / EMBEDDING_DIMENSIONS / OLLAMA_BASE_URL 已随 T1 退役，运行时只读 DB
 *   （provider / model / 默认行 → RuntimeModelRegistry 快照）。host 固定 127.0.0.1（AD-8 仅本地监听）。
 * S3_* 是对象存储必需项；S3_ENDPOINT 必须等于浏览器访问 MinIO 的 Host（presign 的 Host 会被签进 URL），末尾斜杠会被去掉；S3_REGION 默认 us-east-1，S3_FORCE_PATH_STYLE 默认 true。密钥只进 AppConfig，不打印、不进错误信息。
 * EVAL_DATABASE_URL 是可选开关：不设 = 评测跑主库（共享模式）；设了 = 评测世界用独立库（隔离模式）。见 eval/assembly.ts；不进 missing。
 * CONFIG_SECRET_KEY 是可选 env（32 字节 base64）：DB 有密文时必需，空库可缺省；加密/解密与校验全在 adapter/config/secret.ts。
 */

import 'reflect-metadata'
import { singleton } from 'tsyringe'
import type { CodebaseRepo, Repo } from './adapter/contract';
import { logInfo, logError } from './trace/systemtrace/log'

export { AppConfig, getEnv, cleanUpOnBoot }

@singleton()
class AppConfig {
  readonly host = '127.0.0.1'
  readonly port: number
  readonly databaseUrl: string
  readonly evalDatabaseUrl: string | null
  readonly configSecretKey: string | undefined
  readonly s3Endpoint: string
  readonly s3Region: string
  readonly s3Bucket: string
  readonly s3AccessKeyId: string
  readonly s3SecretAccessKey: string
  readonly s3ForcePathStyle: boolean

  constructor() {
    const missing: string[] = []
    const databaseUrl = getEnv('DATABASE_URL', missing)
    const s3EndpointRaw = getEnv('S3_ENDPOINT', missing)
    const s3Bucket = getEnv('S3_BUCKET', missing)
    const s3AccessKeyId = getEnv('S3_ACCESS_KEY_ID', missing)
    const s3SecretAccessKey = getEnv('S3_SECRET_ACCESS_KEY', missing)
    if (missing.length > 0) {
      fail('E_CONFIG_MISSING', `必需的环境变量缺失: ${missing.join(', ')}`)
    }
    this.port = numOrThrow(getEnv('PORT'), 'PORT', 3000, 1, 65535)
    this.databaseUrl = databaseUrl!
    this.evalDatabaseUrl = parseEvalDatabaseUrl(getEnv('EVAL_DATABASE_URL'), this.databaseUrl)
    this.configSecretKey = getEnv('CONFIG_SECRET_KEY')

    this.s3Endpoint = endpointOrThrow(s3EndpointRaw!, 'S3_ENDPOINT')
    this.s3Region = getEnv('S3_REGION') ?? 'us-east-1'
    this.s3Bucket = s3Bucket!
    this.s3AccessKeyId = s3AccessKeyId!
    this.s3SecretAccessKey = s3SecretAccessKey!
    this.s3ForcePathStyle = boolOrThrow(getEnv('S3_FORCE_PATH_STYLE'), 'S3_FORCE_PATH_STYLE', true)
  }
}

async function cleanUpOnBoot(repo: Repo, codebases: CodebaseRepo, EmbeddingDimensions: number | null) {
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
    logInfo('I_VECTOR_DIMENSIONS', `库中向量维度=${stored.join(',') || '空'} 检索维度=${EmbeddingDimensions ?? '未配置'}`)
  } catch (err) {
    logError('E_DIMENSION_PROBE', String(err))
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

function parseEvalDatabaseUrl(Raw: string | undefined, MainUrl: string): string | null {
  if (Raw === undefined) return null
  if (Raw === MainUrl) fail('E_CONFIG_INVALID', 'EVAL_DATABASE_URL 不能与 DATABASE_URL 相同')
  try {
    new URL(Raw)
  } catch {
    fail('E_CONFIG_INVALID', 'EVAL_DATABASE_URL 不是合法 URL')
  }
  return Raw
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
