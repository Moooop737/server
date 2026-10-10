import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { loadConfig, ConfigError, type AppConfig } from "./config"
import { createDbPool, pingDb } from "./adapters/paradedb"
import { pingOllama } from "./adapters/ollama"
import { cleanupInterruptedIngest } from "./pipeline/startup-cleanup"

function bootstrapConfig(): AppConfig {
  try {
    return loadConfig()
  } catch (err) {
    const code = err instanceof ConfigError ? err.code : "E_CONFIG_UNKNOWN"
    const message = err instanceof ConfigError ? err.message : String(err)
    console.error(JSON.stringify({ code, message }))
    process.exit(1)
  }
}

const config = bootstrapConfig()

const app = new Hono()
const pool = createDbPool(config.databaseUrl)

app.get('/health', async (c) => {
  const [db, ollama] = await Promise.all([
    pingDb(pool),
    pingOllama(config.ollamaBaseUrl),
  ])
  const ok = db && ollama
  return c.json(
    { status: ok ? 'ok' : 'degraded', checks: { db, ollama } },
    ok ? 200 : 503,
  )
})

async function bootstrap(): Promise<void> {
  try {
    const cleaned = await cleanupInterruptedIngest(pool)
    if (cleaned.resources > 0) {
      console.log(`启动清扫：${cleaned.resources} 条 processing 资源转为 failed(入库中断)`)
    }
  } catch (err) {
    console.error(JSON.stringify({ code: 'E_CLEANUP', message: String(err) }))
  }

  serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  })

  console.log('Server listening on http://' + config.host + ':' + config.port)
}

void bootstrap()