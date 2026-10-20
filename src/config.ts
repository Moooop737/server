/**
 * 配置装载 —— 从 process.env 读并校验，缺必需项/非法值当场打印结构化 JSON 并 process.exit(1)。
 * 打印与终止都住在本文件：AppConfig 是 @singleton() 类，谁第一个把它叫起来都一样 —— 不依赖调用顺序，也不再包一层 root 侧的 try/catch。
 * 代价说清：这条错误路径**不可被 catch**，要在测试里断「缺 DATABASE_URL 报 E_CONFIG_MISSING」只能开子进程看退出码与 stdout。
 * numOrThrow() 是整数型 env 的解析 + 范围校验工具，floatOrThrow() 管小数（检索阈值）；两者都在构造器里用。
 * embeddingDimensions 非 1024 不阻断、仅 warn：P1 只建 1024 档 partial HNSW，其它维度检索退顺序扫描（结果仍对、只是慢）。见 addendum A / AD-4。
 * CHAT_MODEL 只装载不校验（缺失＝今天不选，填了却不在 model 清单里由 bootstrap 点名退出）；服务商与它的 Key 归 adapter/provider 登记表，本文件不再认 CHAT_PROVIDER。host 固定 127.0.0.1（AD-8 仅本地监听）。
 */

import 'reflect-metadata'
import { singleton } from 'tsyringe'
import type { Repo } from './adapter/contract';

export { AppConfig, getEnv ,cleanUpOnBoot}

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
  readonly retrievalMinSimilarity: number   // 余弦相似度下限（pg 的 <=> 是距离，换算见 retrieve/search/paradedb-vector.ts）
  readonly retrievalRrfK: number            // RRF 的 k，标准取 60
  readonly retrievalDefaultLimit: number    // 融合后送进上下文的条数

  constructor() {
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
      fail('E_CONFIG_MISSING', `必需的环境变量缺失: ${missing.join(', ')}`)
    }

    const embeddingDimensions = numOrThrow(get('EMBEDDING_DIMENSIONS'), 'EMBEDDING_DIMENSIONS', 1024, 1, 16000)
    if (embeddingDimensions !== 1024) {
      console.warn(JSON.stringify({ code: 'W_EMBEDDING_DIM', message: `EMBEDDING_DIMENSIONS=${embeddingDimensions} 无对应 HNSW 索引，检索将退化顺序扫描` }))
    }

    this.port = numOrThrow(get('PORT'), 'PORT', 3000, 1, 65535)
    this.databaseUrl = databaseUrl!
    this.ollamaBaseUrl = ollamaBaseUrl!
    this.embeddingModel = embeddingModel!
    this.embeddingDimensions = embeddingDimensions
    this.chatModel = chatModel

    this.retrievalVectorTopK = numOrThrow(get('RETRIEVAL_VECTOR_TOPK'), 'RETRIEVAL_VECTOR_TOPK', 10, 1, 100)
    this.retrievalLexicalTopK = numOrThrow(get('RETRIEVAL_LEXICAL_TOPK'), 'RETRIEVAL_LEXICAL_TOPK', 10, 1, 100)
    this.retrievalMinSimilarity = floatOrThrow(get('RETRIEVAL_MIN_SIMILARITY'), 'RETRIEVAL_MIN_SIMILARITY', 0.42, 0, 1)
    this.retrievalRrfK = numOrThrow(get('RETRIEVAL_RRF_K'), 'RETRIEVAL_RRF_K', 60, 1, 1000)
    this.retrievalDefaultLimit = numOrThrow(get('RETRIEVAL_DEFAULT_LIMIT'), 'RETRIEVAL_DEFAULT_LIMIT', 6, 1, 100)
  }
}

function fail(code: string, message: string): never {
  console.error(JSON.stringify({ code, message }))
  process.exit(1)
}

async function cleanUpOnBoot(repo: Repo, config: AppConfig) {
  try {
    const cleaned = await repo.markInterruptedAsFailed()
    if (cleaned.resources > 0) {
      console.log(`启动清扫：${cleaned.resources} 条 processing 资源转为 failed(入库中断)`)
    }
  } catch (err) {
    console.error(JSON.stringify({ code: 'E_CLEANUP', message: String(err) }))
  }

  try {
    const stored = await repo.dimensionsInStore()
    console.log(JSON.stringify({
      code: 'I_VECTOR_DIMENSIONS',
      message: `库中向量维度=${stored.join(',') || '空'} 检索维度=${config.embeddingDimensions}`,
    }))
  } catch (err) {
    console.error(JSON.stringify({ code: 'E_DIMENSION_PROBE', message: String(err) }))
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

const getEnv = (name: string): string | undefined => {
  const v = process.env[name]?.trim()
  return v ? v : undefined
}
