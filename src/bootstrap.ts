/**
 * 启动装配 —— bootstrap() 读配置、组装 Deps、建空 app 并交出；startServer() 清理中断遗留后监听。
 * 缺必需 env → loadAppConfig() 打印错误并 process.exit(1)；cleanup 失败只记日志、不阻断启动。
 * 依赖：config / paradedb / ollama-embedder / paradedb-repository / chunk / parse / orchestration。
 */

import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { loadConfig, ConfigError } from "./config"
import { createDbPool } from "./adapters/paradedb"
import { OllamaEmbedder } from "./adapters/ollama-embedder"
import { ParadeDbRepository } from "./adapters/paradedb-repository"
import { LegacyChunker } from "./pipeline/chunk/legacy"
import { TextParser } from "./pipeline/parse/text-parser"

export { bootstrap, startServer }
export type { Deps }

import type { AppConfig } from "./config"
import type { IngestDeps } from "./orchestration/ingest"

interface Deps {
  config: AppConfig
  pool: ReturnType<typeof createDbPool>
  ingestDeps: IngestDeps
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
  const embedder = new OllamaEmbedder({
    baseUrl: Config.ollamaBaseUrl,
    model: Config.embeddingModel,
    dimensions: Config.embeddingDimensions,
  })
  const repo = new ParadeDbRepository(pool)
  const ingestDeps: IngestDeps = {
    parse: new TextParser(),
    chunk: new LegacyChunker(),
    embedder,
    repo,
    embeddingModel: Config.embeddingModel,
  }
  return { config: Config, pool, ingestDeps }
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

  serve({
    fetch: App.fetch,
    hostname: AppDeps.config.host,
    port: AppDeps.config.port,
  })

  console.log('Server listening on http://' + AppDeps.config.host + ':' + AppDeps.config.port)
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
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
