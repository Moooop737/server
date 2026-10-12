/**
 * ParadeDB 连接池 —— 只有 Repository/适配器经此访问库（AD-2）；pingDb() 供健康探针探活。
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
  // remote PG (Tailscale) kills idle conns; Pool emits 'error' → uncaught → silent crash
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
