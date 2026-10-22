/**
 * message —— chat 的写入与按会话读历史；通用 list/read/create/update/delete 由 routes/crud.ts 注册到 hono-crud。
 * parts 是 UI 真源；sequence 由 identity 递增，读时按正序；每条读都带 deleted_at IS NULL。
 */

export { createMessage, getMessagesBySession }
export type { Message }

import type { Pool } from 'pg'
import type { UIMessage } from 'ai'

interface timestamp {
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface Message extends timestamp {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  parts: UIMessage['parts']
  sequence: number
}

function iso(v: Date | null): string | null {
  return v === null ? null : v.toISOString()
}

function rowToMessage(r: any): Message {
  return {
    id: r.id,
    session_id: r.session_id,
    role: r.role,
    content: r.content,
    parts: typeof r.parts === 'string' ? JSON.parse(r.parts) : (r.parts ?? []),
    sequence: Number(r.sequence),
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    deleted_at: iso(r.deleted_at),
  }
}

async function createMessage(
  Db: Pool,
  Data: Pick<Message, 'session_id' | 'role' | 'content' | 'parts'>,
): Promise<Message> {
  const { rows } = await Db.query(
    `INSERT INTO messages (session_id, role, content, parts)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, session_id, role, content, parts, sequence, created_at, updated_at, deleted_at`,
    [Data.session_id, Data.role, Data.content, JSON.stringify(Data.parts)],
  )
  return rowToMessage(rows[0])
}

async function getMessagesBySession(Db: Pool, SessionId: string): Promise<Message[]> {
  const { rows } = await Db.query(
    `SELECT id, session_id, role, content, parts, sequence, created_at, updated_at, deleted_at
     FROM messages
     WHERE session_id = $1 AND deleted_at IS NULL
     ORDER BY sequence ASC`,
    [SessionId],
  )
  return rows.map(rowToMessage)
}
