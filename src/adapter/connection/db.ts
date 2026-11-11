/**
 * 共享 pg 池 —— 全工程唯一 new Pool 的位置仍是 connection/pool.ts；本类只持有它，
 * 让 PostgresRepo 与 Drizzle 查询层共用同一条池，避免两份连接预算。
 * DbHandle 读 DATABASE_URL（主库）；EvalDbHandle 继承它、改读 EVAL_DATABASE_URL，只在评测隔离模式构造。
 * 评测库与主库的表结构由同批迁移维护；配置表副本在评测库里不使用。
 */

export { DbHandle, EvalDbHandle }

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

@singleton()
class EvalDbHandle {
  readonly pool: Pool

  constructor(@inject(AppConfig) Config: AppConfig) {
    if (!Config.evalDatabaseUrl) {
      throw new Error('EVAL_DATABASE_URL 未配置，不能构造评测库连接池')
    }
    this.pool = createDbPool(Config.evalDatabaseUrl)
  }
}
