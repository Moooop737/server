/**
 * 读侧 —— resources / chunks / embeddings 的查询与行投影。
 * 行投影是本层私有的：pg 读回的 timestamptz 是 Date 实例、halfvec 是字符串，两者都不许越过本层（脊「数据与格式」条）。
 * 每个读方法自带未软删谓词，不由调用方拼（AD-3）；例外是 dimensionsInStore()，它数的是 embeddings 的维度事实，与某行是否软删无关。
 * 末尾五个 NotImplemented 是随 Repository 端口一起搬进来的占位：findResourcesByStatus 属清理侧，session/message 四条随 Story 2.2 落库时迁出本层。
 */

export {
  rowToResource, rowToChunk,
  getResource, listResources, countResourcesByStatus, findActiveBySource, getChunksByResource, dimensionsInStore,
  findResourcesByStatus, createSession, getSession, createMessage, getMessagesBySession,
}

import type { Pool } from 'pg'
import type { Resource, Chunk, Session, Message } from '../../types/types'

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

// 库里 embeddings 实际存着哪些维度。检索只能消费与 retrieverConfig.dimension 相等的那些行，
// 存在别的维度 = 换过 embedding 模型而旧数据没重嵌，此时问答必须明确拒绝而不是报「未找到相关内容」。
async function dimensionsInStore(Db: Pool): Promise<number[]> {
  const { rows } = await Db.query(`SELECT DISTINCT dimension FROM embeddings ORDER BY dimension`)
  return rows.map((row: { dimension: number }) => Number(row.dimension))
}

async function findResourcesByStatus(_Db: Pool, _Status: Resource['status']): Promise<Resource[]> {
  throw new Error('NotImplemented: findResourcesByStatus (Story 1.4/cleanup)')
}

async function createSession(_Db: Pool, _Title?: string): Promise<Session> {
  throw new Error('NotImplemented: createSession (Story 2.1)')
}

async function getSession(_Db: Pool, _Id: string): Promise<Session | null> {
  throw new Error('NotImplemented: getSession (Story 2.1)')
}

async function createMessage(
  _Db: Pool,
  _Data: Pick<Message, 'session_id' | 'role' | 'content' | 'sources'>,
): Promise<Message> {
  throw new Error('NotImplemented: createMessage (Story 2.1)')
}

async function getMessagesBySession(_Db: Pool, _SessionId: string): Promise<Message[]> {
  throw new Error('NotImplemented: getMessagesBySession (Story 2.1)')
}
