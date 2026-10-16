/**
 * 连接池 —— 全工程唯一 `new Pool` 的位置。池只在 adapter/ 内部逐层传递，绝不经 contract.ts 交出（AD-3）。
 * createDbPool(DatabaseUrl) 同步返回：pg 的 Pool 是懒连接，构造不触网，探活归 pingDb。
 * pool.on('error') 不能省：远端 PG（Tailscale）掐空闲连接时池会在无人借用时报错，无监听者即 uncaught ⇒ 静默崩进程。
 * max / query_timeout 等旋钮今天仍写死，「进 config」记在脊的 Deferred（归 Lynx 的 SDK 那一刀），数值不提前标定。
 */

export { createDbPool, pingDb }

import { Pool } from 'pg'

function createDbPool(DatabaseUrl: string): Pool {
  const pool = new Pool({
    connectionString: DatabaseUrl,
    max: 5,
    connectionTimeoutMillis: 3000, // fail fast if unreachable; don't hang startup/health
    idleTimeoutMillis: 30000,
    query_timeout: 5000,
  })
  pool.on('error', (err) =>
    console.error(JSON.stringify({ code: 'E_POOL', message: err.message })),
  )
  return pool
}

async function pingDb(Db: Pool): Promise<boolean> {
  try {
    await Db.query('SELECT 1')
    return true
  } catch {
    return false
  }
}
