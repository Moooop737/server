/**
 * 共享 pg 池 —— 全工程唯一 new Pool 的位置仍是 connection/pool.ts；本类只持有它，
 * 让 PostgresRepo 与 Drizzle 查询层共用同一条池，避免两份连接预算。
 */

export { DbHandle }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { createDbPool } from './pool'
import { AppConfig } from '../../config'
import type { Pool } from 'pg'

@singleton()
class DbHandle {
  readonly pool: Pool

  constructor(@inject(AppConfig) Config: AppConfig) {
    this.pool = createDbPool(Config.databaseUrl)
  }
}
