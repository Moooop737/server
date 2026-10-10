import { Pool } from 'pg'

// ParadeDB 连接池：只有 Repository/适配器经此访问库（AD-2）
export function createDbPool(databaseUrl: string): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 3000, // 连不上就快速失败，别 hang 住启动/健康检查
    idleTimeoutMillis: 30000,
    query_timeout: 5000,
  })
  // 远程 PG（走 Tailscale）会掐掉空闲连接；Pool 对被掐的 client emit('error')。
  // 无 'error' 监听 → EventEmitter 抛出未捕获异常 → 进程静默崩。挂个监听兜住。
  pool.on('error', (err) =>
    console.error(JSON.stringify({ code: 'E_POOL', message: err.message })),
  )
  return pool
}

export async function pingDb(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1')
    return true
  } catch {
    return false
  }
}
