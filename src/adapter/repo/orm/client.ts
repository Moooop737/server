/**
 * Drizzle 实例工厂 —— 只接收 repo 内部的 Pool；schema 不出 adapter/repo/（AD-3），实例由 PostgresRepo 交给 Hono context 供 CRUD 使用。
 * schema 由 `npm run db:schema` 生成（含观测表定义）；CRUD 只用其中四张表，BM25/向量仍走 repo/search-*.ts。
 */

export { createOrm }
export type { Orm }

import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'
import type { Pool } from 'pg'

function createOrm(Db: Pool) {
  return drizzle(Db, { schema })
}

type Orm = ReturnType<typeof createOrm>
