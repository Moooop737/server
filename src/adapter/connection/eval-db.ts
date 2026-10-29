/**
 * 评测库连接池 —— 只在隔离模式（EVAL_DATABASE_URL 存在）时被构造。
 * 与 DbHandle 同形：第二个 new Pool 的位置，仍走 connection/pool.ts 的 createDbPool。
 * 共享模式不解析本类：评测世界直接用主库的 DbHandle/PostgresRepo，见 eval/assembly.ts。
 */

export { EvalDbHandle }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { AppConfig } from '../../config'
import { createDbPool } from './pool'
import type { Pool } from 'pg'

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
