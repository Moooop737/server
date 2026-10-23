/**
 * 对话观测的读侧 —— 只读库：会话有哪几次 /chat、每次的本地 trace_id 与 langfuse_trace_id。
 * Langfuse 的内容不在这里取；路由拿到 langfuse_trace_id 后才去远程读，保证首屏只读本地库。
 * 会话软删后不再出现在列表；trace 行仍保留，按本地 id 读详情时不因此 404。
 */

export { listChatSessions, listChatTraces, getChatTrace }
export type { ChatSessionSummary, ChatTraceSummary, ChatPage }

import type { Pool } from 'pg'

interface ChatSessionSummary {
  id: string
  title: string
  updated_at: string
  chat_count: number
  last_chat_at: string
}

interface ChatTraceSummary {
  id: string
  session_id: string | null
  session_title: string | null
  status: string
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  error_code: string | null
  langfuse_trace_id: string | null
}

interface ChatPage<Item> {
  Items: Item[]
  TotalCount: number
}

function iso(Value: Date | string | null): string | null {
  if (Value === null) return null
  return Value instanceof Date ? Value.toISOString() : Value
}

function rowToChatSession(Row: any): ChatSessionSummary {
  return {
    id: Row.id,
    title: Row.title,
    updated_at: iso(Row.updated_at)!,
    chat_count: Number(Row.chat_count),
    last_chat_at: iso(Row.last_chat_at)!,
  }
}

function rowToChatTrace(Row: any): ChatTraceSummary {
  return {
    id: Row.id,
    session_id: Row.session_id,
    session_title: Row.session_title ?? null,
    status: Row.status,
    started_at: iso(Row.started_at)!,
    ended_at: iso(Row.ended_at),
    duration_ms: Row.duration_ms === null ? null : Number(Row.duration_ms),
    error_code: Row.error_code ?? null,
    langfuse_trace_id: Row.langfuse_trace_id ?? null,
  }
}

async function listChatSessions(Db: Pool, Offset: number, Limit: number): Promise<ChatPage<ChatSessionSummary>> {
  const { rows } = await Db.query(
    `SELECT s.id, s.title, s.updated_at,
            COUNT(t.id)::int AS chat_count,
            MAX(t.started_at) AS last_chat_at
       FROM sessions s
       JOIN traces t ON t.session_id = s.id AND t.route = 'POST /chat'
      WHERE s.deleted_at IS NULL
      GROUP BY s.id, s.title, s.updated_at
      ORDER BY MAX(t.started_at) DESC
      LIMIT $1 OFFSET $2`,
    [Limit, Offset],
  )
  const Count = await Db.query(
    `SELECT COUNT(DISTINCT s.id)::int AS total
       FROM sessions s
       JOIN traces t ON t.session_id = s.id AND t.route = 'POST /chat'
      WHERE s.deleted_at IS NULL`,
  )
  return { Items: rows.map(rowToChatSession), TotalCount: Number(Count.rows[0]?.total ?? 0) }
}

async function listChatTraces(Db: Pool, SessionId: string | null, Offset: number, Limit: number): Promise<ChatPage<ChatTraceSummary>> {
  const { rows } = await Db.query(
    `SELECT t.id, t.session_id, s.title AS session_title, t.status, t.started_at, t.ended_at,
            t.duration_ms, t.error_code, t.langfuse_trace_id
       FROM traces t
       LEFT JOIN sessions s ON s.id = t.session_id AND s.deleted_at IS NULL
      WHERE t.route = 'POST /chat' AND ($1::uuid IS NULL OR t.session_id = $1::uuid)
      ORDER BY t.started_at DESC
      LIMIT $2 OFFSET $3`,
    [SessionId, Limit, Offset],
  )
  const Count = await Db.query(
    `SELECT COUNT(*)::int AS total
       FROM traces t
       LEFT JOIN sessions s ON s.id = t.session_id AND s.deleted_at IS NULL
      WHERE t.route = 'POST /chat' AND ($1::uuid IS NULL OR t.session_id = $1::uuid)`,
    [SessionId],
  )
  return { Items: rows.map(rowToChatTrace), TotalCount: Number(Count.rows[0]?.total ?? 0) }
}

async function getChatTrace(Db: Pool, TraceId: string): Promise<ChatTraceSummary | null> {
  const { rows } = await Db.query(
    `SELECT t.id, t.session_id, s.title AS session_title, t.status, t.started_at, t.ended_at,
            t.duration_ms, t.error_code, t.langfuse_trace_id
       FROM traces t
       LEFT JOIN sessions s ON s.id = t.session_id
      WHERE t.id = $1 AND t.route = 'POST /chat'`,
    [TraceId],
  )
  return rows[0] ? rowToChatTrace(rows[0]) : null
}
