import { Pool } from 'pg'

// ParadeDB 连接池：只有 Repository/适配器经此访问库（AD-2）
export function createDbPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 5 })
}

export async function pingDb(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1')
    return true
  } catch {
    return false
  }
}
