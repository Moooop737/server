/**
 * session —— 取单条；创建/更新/列表由 routes/crud.ts 统一注册到 hono-crud。
 * 读都带 deleted_at IS NULL；会话内消息在 message.ts。
 */

export { getSession }
export type { Session }

import type { Pool } from 'pg'

interface timestamp {
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface Session extends timestamp {
  id: string
  title: string
}

function iso(v: Date | null): string | null {
  return v === null ? null : v.toISOString()
}

function rowToSession(r: any): Session {
  return {
    id: r.id,
    title: r.title,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    deleted_at: iso(r.deleted_at),
  }
}

async function getSession(Db: Pool, Id: string): Promise<Session | null> {
  const { rows } = await Db.query(
    `SELECT id, title, created_at, updated_at, deleted_at
     FROM sessions WHERE id = $1 AND deleted_at IS NULL`,
    [Id],
  )
  return rows[0] ? rowToSession(rows[0]) : null
}
