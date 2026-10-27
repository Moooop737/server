/**
 * chunk + embedding —— 按资源读 chunks、删 chunks、chunk/向量/行转 ready 的同事务写入。
 * 事务是这块的唯一边界：要么全写、要么全滚，既杜绝「有 chunk 无向量」，也杜绝「向量已落、行还 processing」。
 * 重入库时同一事务先删该资源旧 chunks（embeddings 随 FK），再插新；中途失败旧数据随事务回滚。
 * number[] ↔ halfvec 字面量字符串的转换住本层（vecToHalfvecStr），不外漏；Embedding 只有写侧。
 */

export { getChunksPage, writeChunksWithEmbeddings, deleteChunksByResource, rowToChunk }
export type { Chunk, ChunkPage, Embedding }

import type { Pool } from 'pg'
import { logError } from '../../trace/systemtrace/log'

interface timestamp {
  created_at: string
  updated_at: string
  deleted_at: string | null
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

interface ChunkPage {
  Items: Chunk[]
  TotalCount: number
}

interface Embedding extends timestamp {
  id: string
  source_id: string
  source_type: 'chunk'
  dimension: number
  model: string
  embedding: number[]
}

function iso(v: Date | null): string | null {
  return v === null ? null : v.toISOString()
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

async function getChunksPage(Db: Pool, ResourceId: string, Offset: number, Limit: number, Search: string): Promise<ChunkPage> {
  const Params: unknown[] = [ResourceId]
  let Where = 'resource_id = $1 AND deleted_at IS NULL'
  if (Search !== '') {
    Params.push(Search)
    /* strpos 是字面量匹配：不像 ILIKE 让用户输入的 % / _ 变成通配符 */
    Where += ` AND strpos(lower(content), lower($${Params.length})) > 0`
  }
  const { rows } = await Db.query(
    `SELECT * FROM chunks WHERE ${Where} ORDER BY chunk_index, id LIMIT $${Params.length + 1} OFFSET $${Params.length + 2}`,
    [...Params, Limit, Offset],
  )
  const Count = await Db.query(`SELECT COUNT(*)::int AS total FROM chunks WHERE ${Where}`, Params)
  return { Items: rows.map(rowToChunk), TotalCount: Number(Count.rows[0]?.total ?? 0) }
}

async function writeChunksWithEmbeddings(
  Db: Pool,
  ResourceId: string,
  Chunks: Pick<Chunk, 'chunk_index' | 'content' | 'start_offset' | 'end_offset'>[],
  Vectors: Pick<Embedding, 'dimension' | 'model' | 'embedding'>[],
): Promise<number> {
  if (Chunks.length === 0) return 0
  const client = await Db.connect()
  try {
    await client.query('BEGIN')

    // FOR UPDATE 串行化同一资源的并发写入/重入库：否则两个事务会各自删旧插新，留下两份 chunks
    const { rows: [res] } = await client.query(
      `SELECT data_uri FROM resources WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [ResourceId],
    )
    if (!res) throw Object.assign(new Error(`资源行不存在或已删除，写入中止: ${ResourceId}`), { code: 'E_RESOURCE_GONE' })
    const resourceUri = res.data_uri as string

    // 重入库覆盖：同一事务先删旧 chunks（embeddings 随 FK CASCADE），再插新；失败整体回滚
    await client.query(`DELETE FROM chunks WHERE resource_id = $1`, [ResourceId])

    const cValues: string[] = []
    const cParams: unknown[] = []
    let i = 1
    for (const c of Chunks) {
      cValues.push(`($${i}, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5})`)
      cParams.push(ResourceId, resourceUri, c.chunk_index, c.content, c.start_offset, c.end_offset)
      i += 6
    }
    const { rows: chunkRows } = await client.query(
      `INSERT INTO chunks (resource_id, resource_uri, chunk_index, content, start_offset, end_offset)
         VALUES ${cValues.join(',')}
         RETURNING id, chunk_index`,
      cParams,
    )
    const idByIndex = new Map<number, string>(
      chunkRows.map((r) => [r.chunk_index as number, r.id as string]),
    )

    const eValues: string[] = []
    const eParams: unknown[] = []
    let j = 1
    for (let k = 0; k < Chunks.length; k++) {
      const sourceId = idByIndex.get(Chunks[k]!.chunk_index)!
      const v = Vectors[k]!
      eValues.push(`($${j}, $${j + 1}, $${j + 2}, $${j + 3}, $${j + 4}::halfvec)`)
      eParams.push(sourceId, 'chunk', v.dimension, v.model, vecToHalfvecStr(v.embedding))
      j += 5
    }
    await client.query(
      `INSERT INTO embeddings (source_id, source_type, dimension, model, embedding)
         VALUES ${eValues.join(',')}`,
      eParams,
    )

    // 带 deleted_at 谓词：软删若发生在 embed 之后、写入期间，这里 rowCount=0 就整笔回滚，
    // 杜绝给一条已删资源补写一批 chunks（那是检索会命中的孤儿数据）
    const { rowCount } = await client.query(
      `UPDATE resources SET status = 'ready', error_reason = NULL, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [ResourceId],
    )
    if (rowCount === 0) throw Object.assign(new Error(`资源在写入期间被删除，写入中止: ${ResourceId}`), { code: 'E_RESOURCE_GONE' })

    await client.query('COMMIT')
    return Chunks.length
  } catch (err) {
    await client.query('ROLLBACK').catch((rbErr) =>
      logError('E_ROLLBACK', String(rbErr)),
    ) // 别用回滚自身的错顶掉真因
    throw err
  } finally {
    client.release()
  }
}

// 删 chunk；embedding 经 FK source_id→chunks.id ON DELETE CASCADE 随之删除，无孤儿向量
async function deleteChunksByResource(Db: Pool, ResourceId: string): Promise<void> {
  await Db.query(`DELETE FROM chunks WHERE resource_id = $1`, [ResourceId])
}

/** number[] → pg halfvec 字面量字符串 '[0.1,0.2,...]' */
function vecToHalfvecStr(v: number[]): string {
  return `[${v.join(',')}]`
}
