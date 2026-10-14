/**
 * 启动装配 —— bootstrap() 读配置、组装 Deps（进程级入库管线工厂 + 检索工厂）、建空 app 并交出；startServer() 清理中断遗留、探一次向量维度、然后监听。
 * 缺必需 env → loadAppConfig() 打印错误并 process.exit(1)；cleanup 与维度体检失败都只记日志、不阻断启动。
 * Deps.pipelineFactory / Deps.retrieverFactory 都是进程级单例工厂，路由各自在请求里 assemble(Recipe)；
 * Deps.inflight 是进程级取消登记处，工厂持有它、路由也用它（同一个实例，取消才按得到）。
 * pipelineConfig / retrieverConfig 由 AppConfig 派生，供路由装 Recipe（策略名 + 活依赖 + config）。
 * Deps.vectorDimensions 是唯一的「启动后后填」字段，三态：buildDeps 先给 null，startServer 在 serve() 之前填成真值数组 ⇒ 路由不可能读到半填状态。
 * 体检失败就留在 null，检索会因此**拒绝作答**（E_DIMENSION_UNKNOWN）而不是退回 BM25-only 静默命中 —— 见 retrieve/retrievers.ts。
 * 依赖：config / paradedb / paradedb-repository / pipeline(recipes,inflight,pipelines) / retrieve(recipes,retrievers)。
 */

import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { loadConfig, ConfigError } from "./config"
import { createDbPool } from "./adapters/paradedb"
import { ParadeDbRepository } from "./adapters/paradedb-repository"
import { createStageRegistry } from "./pipeline/recipes"
import { InflightRegistry } from "./pipeline/inflight"
import { PipelineFactory } from "./pipeline/pipelines"

export { bootstrap, startServer }
export type { Deps }

import type { AppConfig } from "./config"
import type { Repository } from "./ports/repository"
import type { PipelineConfig } from "./pipeline/contracts"
import type { RetrieverConfig } from "./retrieve/contracts";
import { RetrieverFactory } from "./retrieve/retrievers";
import { createRetrieverStageRegistry } from "./retrieve/recipes";

interface Deps {
  config: AppConfig
  pool: ReturnType<typeof createDbPool>
  repo: Repository
  inflight: InflightRegistry
  pipelineConfig: PipelineConfig
  pipelineFactory: PipelineFactory
  retrieverConfig: RetrieverConfig
  retrieverFactory: RetrieverFactory
  vectorDimensions: number[] | null
}

function bootstrap(): { app: Hono; deps: Deps } {
  const deps = buildDeps(loadAppConfig())
  return { app: new Hono(), deps }
}

function loadAppConfig(): AppConfig {
  try {
    return loadConfig()
  } catch (err) {
    const code = err instanceof ConfigError ? err.code : "E_CONFIG_UNKNOWN"
    const message = err instanceof ConfigError ? err.message : String(err)
    console.error(JSON.stringify({ code, message }))
    process.exit(1)
  }
}

function buildDeps(Config: AppConfig): Deps {
  const pool = createDbPool(Config.databaseUrl)
  const repo = new ParadeDbRepository(pool)
  const pipelineConfig: PipelineConfig = {
    ollamaBaseUrl: Config.ollamaBaseUrl,
    embeddingModel: Config.embeddingModel,
    embeddingDimensions: Config.embeddingDimensions,
  }
  const inflight = new InflightRegistry()
  const pipelineFactory = new PipelineFactory(createStageRegistry(), inflight)
  const retrieverConfig: RetrieverConfig = {
    dimension: Config.embeddingDimensions,
    vectorTopK: Config.retrievalVectorTopK,
    lexicalTopK: Config.retrievalLexicalTopK,
    minSimilarity: Config.retrievalMinSimilarity,
    rrfK: Config.retrievalRrfK,
    defaultLimit: Config.retrievalDefaultLimit,
    ollamaBaseUrl: Config.ollamaBaseUrl,
    embeddingModel: Config.embeddingModel,
  }
  const retrieverFactory = new RetrieverFactory(createRetrieverStageRegistry())
  return {
    config: Config,
    pool,
    repo,
    inflight,
    pipelineConfig,
    pipelineFactory,
    retrieverConfig,
    retrieverFactory,
    vectorDimensions: null,
  }
}

interface CleanupResult {
  resources: number
}

async function startServer(App: Hono, AppDeps: Deps): Promise<void> {
  try {
    const cleaned = await cleanupInterruptedIngest(AppDeps.pool)
    if (cleaned.resources > 0) {
      console.log(`启动清扫：${cleaned.resources} 条 processing 资源转为 failed(入库中断)`)
    }
  } catch (err) {
    console.error(JSON.stringify({ code: 'E_CLEANUP', message: String(err) }))
  }

  try {
    AppDeps.vectorDimensions = await probeVectorDimensions(AppDeps.pool)
    console.log(JSON.stringify({
      code: 'I_VECTOR_DIMENSIONS',
      message: `库中向量维度=${AppDeps.vectorDimensions.join(',') || '空'} 检索维度=${AppDeps.retrieverConfig.dimension}`,
    }))
  } catch (err) {
    console.error(JSON.stringify({ code: 'E_DIMENSION_PROBE', message: String(err) }))
  }

  serve({
    fetch: App.fetch,
    hostname: AppDeps.config.host,
    port: AppDeps.config.port,
  })

  console.log('Server listening on http://' + AppDeps.config.host + ':' + AppDeps.config.port)
}

// 库里 embeddings 实际存着哪些维度。检索只能消费与 retrieverConfig.dimension 相等的那些行，
// 存在别的维度 = 换过 embedding 模型而旧数据没重嵌，此时问答必须明确拒绝而不是报「未找到相关内容」。
async function probeVectorDimensions(Pool: Deps['pool']): Promise<number[]> {
  const { rows } = await Pool.query(`SELECT DISTINCT dimension FROM embeddings ORDER BY dimension`)
  return rows.map((row: { dimension: number }) => Number(row.dimension))
}

async function cleanupInterruptedIngest(Pool: Deps['pool']): Promise<CleanupResult> {
  const client = await Pool.connect()
  try {
    await client.query('BEGIN')

    const { rows } = await client.query(
      `SELECT id FROM resources WHERE status = 'processing' AND deleted_at IS NULL`,
    )
    const ids: string[] = rows.map((r) => r.id as string)

    if (ids.length > 0) {
      await client.query(`DELETE FROM chunks WHERE resource_id = ANY($1::uuid[])`, [ids])
      await client.query(
        `UPDATE resources SET status = 'failed', error_reason = '入库中断', updated_at = now() WHERE id = ANY($1::uuid[])`,
        [ids],
      )
    }

    await client.query('COMMIT')
    return { resources: ids.length }
  } catch (err) {
    await client.query('ROLLBACK').catch((rbErr) =>
      console.error(JSON.stringify({ code: 'E_ROLLBACK', message: String(rbErr) })),
    ) // 别用回滚自身的错顶掉真因
    throw err
  } finally {
    client.release()
  }
}
