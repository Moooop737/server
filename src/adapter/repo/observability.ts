/**
 * 对话观测的读侧 —— 只读库：会话有哪几次 /chat、每次的本地 trace 与 langfuse_trace_id、
 * 以及一个会话按轮摊平的消息（transcript）。Langfuse 的内容不在这里取；
 * 路由拿到 langfuse_trace_id 后才去远程读，保证首屏只读本地库。
 * 会话软删后不再出现在列表；trace 行仍保留，按本地 id 读详情时不因此 404。
 * transcript 的轮 = traces 里这一会话的全部 POST /chat 行（正序）；消息按 messages.trace_id 归到轮上，
 * 没有消息的轮也保留（失败/取消、多轮落库之前的老对话），前端才有状态可看。
 * 全部走 Drizzle；聚合用 count / countDistinct / max。
 */

export { listChatSessions, getChatTrace, getSessionTranscript }
export type { ChatSessionSummary, ChatTraceSummary, ChatTurn, TranscriptMessage }

import { and, asc, count, countDistinct, desc, eq, isNotNull, isNull, max } from 'drizzle-orm'
import { messages, sessions, traces } from './orm/schema'
import type { Orm } from './orm/client'

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

const ChatTraceColumns = {
  id: traces.id,
  session_id: traces.session_id,
  session_title: sessions.title,
  status: traces.status,
  started_at: traces.started_at,
  ended_at: traces.ended_at,
  duration_ms: traces.duration_ms,
  error_code: traces.error_code,
  langfuse_trace_id: traces.langfuse_trace_id,
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

async function listChatSessions(Db: Orm, Offset: number, Limit: number): Promise<{ Items: ChatSessionSummary[]; TotalCount: number }> {
  const Items = await Db.select({
    id: sessions.id,
    title: sessions.title,
    group_name: sessions.group_name,
    updated_at: sessions.updated_at,
    chat_count: count(traces.id),
    last_chat_at: max(traces.started_at),
  })
    .from(sessions)
    .innerJoin(traces, and(eq(traces.session_id, sessions.id), eq(traces.route, 'POST /chat')))
    .where(isNull(sessions.deleted_at))
    .groupBy(sessions.id, sessions.title, sessions.group_name, sessions.updated_at)
    .orderBy(desc(max(traces.started_at)))
    .limit(Limit)
    .offset(Offset)
  const CountRows = await Db.select({ total: countDistinct(sessions.id) })
    .from(sessions)
    .innerJoin(traces, and(eq(traces.session_id, sessions.id), eq(traces.route, 'POST /chat')))
    .where(isNull(sessions.deleted_at))
  return { Items: Items.map(rowToChatSession), TotalCount: CountRows[0]!.total }
}

async function getChatTrace(Db: Orm, TraceId: string): Promise<ChatTraceSummary | null> {
  const rows = await Db.select(ChatTraceColumns)
    .from(traces)
    .leftJoin(sessions, eq(sessions.id, traces.session_id))
    .where(and(eq(traces.id, TraceId), eq(traces.route, 'POST /chat')))
    .limit(1)
  return rows[0] ? rowToChatTrace(rows[0]) : null
}

async function getSessionTranscript(Db: Orm, SessionId: string): Promise<ChatTurn[]> {
  const Traces = await Db.select(ChatTraceColumns)
    .from(traces)
    .leftJoin(sessions, eq(sessions.id, traces.session_id))
    .where(and(eq(traces.route, 'POST /chat'), eq(traces.session_id, SessionId)))
    .orderBy(asc(traces.started_at))
  const Messages = await Db.select({
    id: messages.id,
    trace_id: messages.trace_id,
    role: messages.role,
    content: messages.content,
    created_at: messages.created_at,
  })
    .from(messages)
    .where(and(
      eq(messages.session_id, SessionId),
      isNull(messages.deleted_at),
      isNotNull(messages.trace_id),
    ))
    .orderBy(asc(messages.sequence))
  const ByTrace = new Map<string, TranscriptMessage[]>()
  for (const Row of Messages) {
    if (Row.trace_id === null) continue
    const List = ByTrace.get(Row.trace_id) ?? []
    List.push(rowToTranscriptMessage(Row))
    ByTrace.set(Row.trace_id, List)
  }
  return Traces.map((Row) => {
    const Trace = rowToChatTrace(Row)
    return { trace: Trace, messages: ByTrace.get(Trace.id) ?? [] }
  })
}
