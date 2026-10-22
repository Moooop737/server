/**
 * 只供 `npm run db:schema` 的 introspect 使用；迁移真源是 dbmate。
 * schema 生成时已剔除索引，不要拿它跑 drizzle-kit generate/push。
 */

import type { Config } from 'drizzle-kit'

const DatabaseUrl = process.env.DATABASE_URL
if (!DatabaseUrl) throw new Error('DATABASE_URL is required for db:schema')

export default {
  dialect: 'postgresql',
  schema: './src/adapter/repo/orm/schema.ts',
  out: './db/.drizzle',
  dbCredentials: { url: DatabaseUrl },
  schemaFilter: ['public'],
  tablesFilter: ['resources', 'sessions', 'messages', 'traces', 'trace_stages'],
  introspect: { casing: 'preserve' },
} satisfies Config
