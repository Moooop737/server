/**
 * session —— 取单条；创建/更新/列表由 routes/crud.ts 统一注册到 hono-crud。
 * 读都带 deleted_at IS NULL；会话内消息在 message.ts。
 */

export { getSession }
export type { Session }

import { and, eq, isNull } from 'drizzle-orm'
import { sessions } from './orm/schema'
import type { Orm } from './orm/client'

interface timestamp {
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface Session extends timestamp {
  id: string
  title: string
  group_name: string | null
  model: string | null
}

function iso(v: Date | null): string | null {
  return v === null ? null : v.toISOString()
}

function rowToSession(r: any): Session {
  return {
    id: r.id,
    title: r.title,
    group_name: r.group_name,
    model: r.model,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    deleted_at: iso(r.deleted_at),
  }
}

async function getSession(Db: Orm, Id: string): Promise<Session | null> {
  const rows = await Db.select()
    .from(sessions)
    .where(and(eq(sessions.id, Id), isNull(sessions.deleted_at)))
    .limit(1)
  return rows[0] ? rowToSession(rows[0]) : null
}
