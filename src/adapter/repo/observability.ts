/**
 * 对话观测的读侧 —— 只读库：会话有哪几次 /chat、每次的本地 trace 与 langfuse_trace_id、
 * 以及一个会话按轮摊平的消息（transcript）。Langfuse 的内容不在这里取；
 * 路由拿到 langfuse_trace_id 后才去远程读，保证首屏只读本地库。
 * 会话软删后不再出现在列表；trace 行仍保留，按本地 id 读详情时不因此 404。
 * transcript 的轮 = traces 里这一会话的全部 POST /chat 行（正序）；消息按 messages.trace_id 归到轮上，
 * 没有消息的轮也保留（失败/取消、多轮落库之前的老对话），前端才有状态可看。
 */

export { listChatSessions, getChatTrace, getSessionTranscript }
export type { ChatSessionSummary, ChatTraceSummary, ChatTurn, TranscriptMessage }

import type { Pool } from 'pg'

interface ChatSessionSummary {
  id: string
  title: string
  group_name: string | null
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

interface TranscriptMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

interface ChatTurn {
  trace: ChatTraceSummary
  messages: TranscriptMessage[]
}

function iso(Value: Date | string | null): string | null {
  if (Value === null) return null
  return Value instanceof Date ? Value.toISOString() : Value
}

function rowToChatSession(Row: any): ChatSessionSummary {
  return {
    id: Row.id,
    title: Row.title,
    group_name: Row.group_name ?? null,
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

function rowToTranscriptMessage(Row: any): TranscriptMessage {
  return {
    id: Row.id,
    role: Row.role,
    content: Row.content,
    created_at: iso(Row.created_at)!,
  }
}

async function listChatSessions(Db: Pool, Offset: number, Limit: number): Promise<{ Items: ChatSessionSummary[]; TotalCount: number }> {
  const { rows } = await Db.query(
    `SELECT s.id, s.title, s.group_name, s.updated_at,
            COUNT(t.id)::int AS chat_count,
            MAX(t.started_at) AS last_chat_at
       FROM sessions s
       JOIN traces t ON t.session_id = s.id AND t.route = 'POST /chat'
      WHERE s.deleted_at IS NULL
      GROUP BY s.id, s.title, s.group_name, s.updated_at
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

async function getSessionTranscript(Db: Pool, SessionId: string): Promise<ChatTurn[]> {
  const Traces = await Db.query(
    `SELECT t.id, t.session_id, s.title AS session_title, t.status, t.started_at, t.ended_at,
            t.duration_ms, t.error_code, t.langfuse_trace_id
       FROM traces t
       LEFT JOIN sessions s ON s.id = t.session_id
      WHERE t.route = 'POST /chat' AND t.session_id = $1
      ORDER BY t.started_at ASC`,
    [SessionId],
  )
  const Messages = await Db.query(
    `SELECT id, trace_id, role, content, created_at
       FROM messages
      WHERE session_id = $1 AND deleted_at IS NULL AND trace_id IS NOT NULL
      ORDER BY sequence ASC`,
    [SessionId],
  )
  const ByTrace = new Map<string, TranscriptMessage[]>()
  for (const Row of Messages.rows) {
    const List = ByTrace.get(Row.trace_id) ?? []
    List.push(rowToTranscriptMessage(Row))
    ByTrace.set(Row.trace_id, List)
  }
  return Traces.rows.map((Row) => {
    const Trace = rowToChatTrace(Row)
    return { trace: Trace, messages: ByTrace.get(Trace.id) ?? [] }
  })
}
