/**
 * 读侧 —— resources / chunks / embeddings 的查询与行投影。
 * 行投影是本层私有的：pg 读回的 timestamptz 是 Date 实例、halfvec 是字符串，两者都不许越过本层（脊「数据与格式」条）。
 * 每个读方法自带未软删谓词，不由调用方拼（AD-3）；例外是 dimensionsInStore()，它数的是 embeddings 的维度事实，与某行是否软删无关。
 * session/message 四条已按 Story 2.5 落回本层；findResourcesByStatus 仍是清理侧占位。
 * 实体形状住本层（timestamp / Resource / Chunk / Session / Message）：谁产出行投影谁定义；Embedding 只有写侧，就近住 write-content.ts。
 */

export {
  rowToResource, rowToChunk, rowToSession, rowToMessage,
  getResource, listResources, countResourcesByStatus, findActiveBySource, getChunksByResource, dimensionsInStore,
  findResourcesByStatus, createSession, getSession, listSessions, createMessage, getMessagesBySession,
}

export type { timestamp, Resource, Chunk, Session, Message }

import type { Pool } from 'pg'
import type { UIMessage } from 'ai'

interface timestamp {
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface Resource extends timestamp {
  id: string
  title: string
  source: string | null
  data_uri: string
  content_type: 'url' | 'markdown' | 'plaintext'
  status: 'processing' | 'ready' | 'failed'
  error_reason: string | null
}

interface Chunk extends timestamp {
  id: string
  resource_id: string
  resource_uri: string
  chunk_index: number
  content: string
  start_offset: number | null
  end_offset: number | null
}

interface Session extends timestamp {
  session_id: string
  title: string
}

interface Message extends timestamp {
  message_id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  parts: UIMessage['parts']
  sequence: number
}

function rowToResource(r: any): Resource {
  return {
    id: r.id,
    title: r.title,
    source: r.source,
    data_uri: r.data_uri,
    content_type: r.content_type,
    status: r.status,
    error_reason: r.error_reason,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    deleted_at: iso(r.deleted_at),
  }
}

function rowToChunk(r: any): Chunk {
  return {
    id: r.id,
    resource_id: r.resource_id,
    resource_uri: r.resource_uri,
    chunk_index: r.chunk_index,
    content: r.content,
    start_offset: r.start_offset,
    end_offset: r.end_offset,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    deleted_at: iso(r.deleted_at),
  }
}

function rowToSession(r: any): Session {
  return {
    session_id: r.session_id,
    title: r.title,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    deleted_at: iso(r.deleted_at),
  }
}

function rowToMessage(r: any): Message {
  return {
    message_id: r.message_id,
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

// Date → ISO string; null → null。pg 读回的 timestamptz 是 Date 实例，这一位不许越过本层
function iso(v: Date | string | null): string | null {
  if (v === null) return null
  return v instanceof Date ? v.toISOString() : v
}

async function getResource(Db: Pool, Id: string): Promise<Resource | null> {
  const { rows } = await Db.query(
    `SELECT * FROM resources WHERE id = $1 AND deleted_at IS NULL`,
    [Id],
  )
  return rows[0] ? rowToResource(rows[0]) : null
}

async function listResources(Db: Pool): Promise<Resource[]> {
  const { rows } = await Db.query(
    `SELECT * FROM resources WHERE deleted_at IS NULL ORDER BY created_at DESC`,
  )
  return rows.map(rowToResource)
}

// 只数未软删的行；三个状态都给键（没命中补 0）。基础层只报事实，「空库 / 全无 ready」的判定归调用方。
async function countResourcesByStatus(Db: Pool): Promise<Record<Resource['status'], number>> {
  const { rows } = await Db.query(
    `SELECT status, count(*)::int AS n FROM resources WHERE deleted_at IS NULL GROUP BY status`,
  )
  const counts: Record<Resource['status'], number> = { processing: 0, ready: 0, failed: 0 }
  for (const row of rows) counts[row.status as Resource['status']] = Number(row.n)
  return counts
}

async function findActiveBySource(Db: Pool, Url: string): Promise<Resource | null> {
  const { rows } = await Db.query(
    `SELECT * FROM resources
       WHERE source = $1 AND status IN ('ready', 'processing') AND deleted_at IS NULL
       LIMIT 1`,
    [Url],
  )
  return rows[0] ? rowToResource(rows[0]) : null
}

async function getChunksByResource(Db: Pool, ResourceId: string): Promise<Chunk[]> {
  const { rows } = await Db.query(
    `SELECT * FROM chunks WHERE resource_id = $1 AND deleted_at IS NULL ORDER BY chunk_index`,
    [ResourceId],
  )
  return rows.map(rowToChunk)
}

// 库里 embeddings 实际存着哪些维度。检索只能消费与 config.embeddingDimensions 相等的那些行，
// 存在别的维度 = 换过 embedding 模型而旧数据没重嵌，此时问答必须明确拒绝而不是报「未找到相关内容」。
async function dimensionsInStore(Db: Pool): Promise<number[]> {
  const { rows } = await Db.query(`SELECT DISTINCT dimension FROM embeddings ORDER BY dimension`)
  return rows.map((row: { dimension: number }) => Number(row.dimension))
}

async function findResourcesByStatus(_Db: Pool, _Status: Resource['status']): Promise<Resource[]> {
  throw new Error('NotImplemented: findResourcesByStatus (Story 1.4/cleanup)')
}

async function createSession(Db: Pool, Title?: string): Promise<Session> {
  const { rows } = await Db.query(
    `INSERT INTO sessions (title) VALUES ($1)
     RETURNING session_id, title, created_at, updated_at, deleted_at`,
    [Title ?? ''],
  )
  return rowToSession(rows[0])
}

async function getSession(Db: Pool, Id: string): Promise<Session | null> {
  const { rows } = await Db.query(
    `SELECT session_id, title, created_at, updated_at, deleted_at
     FROM sessions WHERE session_id = $1 AND deleted_at IS NULL`,
    [Id],
  )
  return rows[0] ? rowToSession(rows[0]) : null
}

async function listSessions(Db: Pool): Promise<Session[]> {
  const { rows } = await Db.query(
    `SELECT session_id, title, created_at, updated_at, deleted_at
     FROM sessions WHERE deleted_at IS NULL
     ORDER BY created_at DESC, session_id DESC`,
  )
  return rows.map(rowToSession)
}

async function createMessage(
  Db: Pool,
  Data: Pick<Message, 'session_id' | 'role' | 'content' | 'parts'>,
): Promise<Message> {
  const { rows } = await Db.query(
    `INSERT INTO messages (session_id, role, content, parts)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING message_id, session_id, role, content, parts, sequence, created_at, updated_at, deleted_at`,
    [Data.session_id, Data.role, Data.content, JSON.stringify(Data.parts)],
  )
  return rowToMessage(rows[0])
}

async function getMessagesBySession(Db: Pool, SessionId: string): Promise<Message[]> {
  const { rows } = await Db.query(
    `SELECT message_id, session_id, role, content, parts, sequence, created_at, updated_at, deleted_at
     FROM messages
     WHERE session_id = $1 AND deleted_at IS NULL
     ORDER BY sequence ASC`,
    [SessionId],
  )
  return rows.map(rowToMessage)
}
