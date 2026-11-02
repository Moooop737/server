/**
 * message —— chat 的写入与按会话读历史；通用 list/read/create/update/delete 由 routes/crud.ts 注册到 hono-crud。
 * parts 是 UI 真源（jsonb，直接收对象）；sequence 由 identity 递增，读时按正序；每条读都带 deleted_at IS NULL。
 */

export { createMessage, getMessagesBySession }
export type { Message }

import { and, asc, eq, isNull } from 'drizzle-orm'
import { messages } from './orm/schema'
import type { Orm } from './orm/client'
import type { UIMessage } from 'ai'

interface timestamp {
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface Message extends timestamp {
  id: string
  session_id: string
  /** 这一轮 /chat 的本地 trace；老会话或直连写入时可为 null */
  trace_id: string | null
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
    trace_id: r.trace_id ?? null,
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
  Db: Orm,
  Data: Pick<Message, 'session_id' | 'role' | 'content' | 'parts'> & Partial<Pick<Message, 'trace_id'>>,
): Promise<Message> {
  const rows = await Db.insert(messages).values({
    session_id: Data.session_id,
    trace_id: Data.trace_id ?? null,
    role: Data.role,
    content: Data.content,
    parts: Data.parts,
  }).returning()
  return rowToMessage(rows[0])
}

async function getMessagesBySession(Db: Orm, SessionId: string): Promise<Message[]> {
  const rows = await Db.select()
    .from(messages)
    .where(and(eq(messages.session_id, SessionId), isNull(messages.deleted_at)))
    .orderBy(asc(messages.sequence))
  return rows.map(rowToMessage)
}
