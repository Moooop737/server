/**
 * 资源功能 —— 资源行的读/写：getResource/getResourceIncludingDeleted、建行、改状态/标题/存储大小、软删/恢复、启动清扫。
 * list/read 的 HTTP 投影由 routes/crud.ts 统一注册到 hono-crud；这里保留自定义写路径与 getResource。
 * getResource 走 Drizzle；其余仍是 pg 裸 SQL。除恢复外，每条 UPDATE 都带 deleted_at IS NULL。
 * softDeleteResource 与 chunk.ts 的 deleteChunksByResource 故意不合并：前者在软删事务内，后者是无事务单语句清理。
 */

export {
  createResource, updateResourceStatus, updateResourceTitle, softDeleteResource, markResourceUploaded, restoreResource,
  getResource, getResourceIncludingDeleted, getResourceByContentHash, findActiveBySource, dataUriExists, resourceCounts, markStaleOnBoot,
  listDeletedResources, purgeResource,
}
export type { Resource, ResourceStatus, ResourceCounts }

import { and, eq, isNull } from 'drizzle-orm'
import type { Pool, PoolClient } from 'pg'
import { resources } from './orm/schema'
import { logError } from '../../trace/systemtrace/log'
import type { Orm } from './orm/client'

interface timestamp {
  created_at: string
  updated_at: string
  deleted_at: string | null
}

type ResourceStatus = 'uploading' | 'uploaded' | 'processing' | 'ready' | 'upload_failed' | 'process_failed'

interface Resource extends timestamp {
  id: string
  title: string
  source: string | null
  data_uri: string
  content_type: string
  status: ResourceStatus
  error_reason: string | null
  storage_size_bytes: number | null
  content_hash: string | null
}

interface ResourceCounts {
  uploading: number
  uploaded: number
  processing: number
  ready: number
  upload_failed: number
  process_failed: number
  other: number
  total: number
}

function iso(v: Date | null): string | null {
  return v === null ? null : v.toISOString()
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
    storage_size_bytes: r.storage_size_bytes == null ? null : Number(r.storage_size_bytes),
    content_hash: r.content_hash ?? null,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    deleted_at: iso(r.deleted_at),
  }
}

async function getResource(Db: Orm, Id: string): Promise<Resource | null> {
  const rows = await Db.select()
    .from(resources)
    .where(and(eq(resources.id, Id), isNull(resources.deleted_at)))
    .limit(1)
  return rows[0] ? rowToResource(rows[0]) : null
}

async function getResourceIncludingDeleted(Db: Orm, Id: string): Promise<Resource | null> {
  const rows = await Db.select()
    .from(resources)
    .where(eq(resources.id, Id))
    .limit(1)
  return rows[0] ? rowToResource(rows[0]) : null
}

async function findActiveBySource(Db: Pool, Url: string): Promise<Resource | null> {
  const { rows } = await Db.query(
    `SELECT * FROM resources
       WHERE source = $1 AND status IN ('uploading', 'uploaded', 'processing', 'ready') AND deleted_at IS NULL
       LIMIT 1`,
    [Url],
  )
  return rows[0] ? rowToResource(rows[0]) : null
}

async function getResourceByContentHash(Db: Orm, Hash: string): Promise<Resource | null> {
  const rows = await Db.select()
    .from(resources)
    .where(eq(resources.content_hash, Hash))
    .limit(1)
  return rows[0] ? rowToResource(rows[0]) : null
}

async function listDeletedResources(
  Db: Pool,
  Offset: number,
  Limit: number,
  Search: string,
): Promise<{ Items: Resource[]; TotalCount: number }> {
  const Pattern = Search === '' ? null : `%${Search}%`
  const { rows } = await Db.query(
    `SELECT * FROM resources
      WHERE deleted_at IS NOT NULL
        AND ($3::text IS NULL OR title ILIKE $3 OR source ILIKE $3)
      ORDER BY deleted_at DESC, id DESC
      LIMIT $1 OFFSET $2`,
    [Limit, Offset, Pattern],
  )
  const { rows: CountRows } = await Db.query(
    `SELECT COUNT(*)::int AS n FROM resources
      WHERE deleted_at IS NOT NULL
        AND ($1::text IS NULL OR title ILIKE $1 OR source ILIKE $1)`,
    [Pattern],
  )
  return { Items: rows.map(rowToResource), TotalCount: Number(CountRows[0]!.n) }
}

// 彻底删除：只接软删行；chunks/embeddings 经外键 CASCADE 一起走，content_hash 随行释放
async function purgeResource(Db: Pool, Id: string): Promise<Resource | null> {
  const { rows } = await Db.query(
    `DELETE FROM resources WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *`,
    [Id],
  )
  return rows[0] ? rowToResource(rows[0]) : null
}

async function dataUriExists(Db: Orm, Uri: string): Promise<boolean> {
  const rows = await Db.select({ id: resources.id })
    .from(resources)
    .where(eq(resources.data_uri, Uri))
    .limit(1)
  return rows.length > 0
}

async function createResource(
  Db: Pool,
  Data: Pick<Resource, 'title' | 'source' | 'data_uri' | 'content_type' | 'status'>
    & Partial<Pick<Resource, 'storage_size_bytes' | 'content_hash'>>,
): Promise<Resource> {
  const { rows } = await Db.query(
    `INSERT INTO resources (title, source, data_uri, content_type, status, storage_size_bytes, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
    [Data.title, Data.source, Data.data_uri, Data.content_type, Data.status, Data.storage_size_bytes ?? null, Data.content_hash ?? null],
  )
  return rowToResource(rows[0])
}

async function updateResourceStatus(
  Db: Pool,
  Id: string,
  Status: Resource['status'],
  Reason?: string,
): Promise<void> {
  await Db.query(
    `UPDATE resources SET status = $2, error_reason = $3, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [Id, Status, Reason ?? null],
  )
}

async function updateResourceTitle(Db: Pool, Id: string, Title: string): Promise<void> {
  await Db.query(
    `UPDATE resources SET title = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [Id, Title],
  )
}

// 上传成功的唯一状态落点：对象已 stat 到、大小已确认；允许从 uploading/uploaded/upload_failed/ready 重试
async function markResourceUploaded(Db: Pool, Id: string, Size: number, ContentType?: string): Promise<boolean> {
  const { rowCount } = await Db.query(
    `UPDATE resources
        SET status = 'uploaded', storage_size_bytes = $2, content_type = COALESCE($3::text, content_type),
            error_reason = NULL, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL AND status IN ('uploading', 'uploaded', 'upload_failed', 'ready')`,
    [Id, Size, ContentType ?? null],
  )
  return rowCount === 1
}

// 软删：resources 行留痕（deleted_at），检索数据物理移除（chunks → embeddings 经 FK CASCADE 一起走）
// 返回 false = 该行不存在或早已软删，交调用方决定怎么报
async function softDeleteResource(Db: Pool, Id: string): Promise<boolean> {
  const client = await Db.connect()
  try {
    await client.query('BEGIN')
    const { rowCount } = await client.query(
      `UPDATE resources SET deleted_at = now(), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
      [Id],
    )
    if (rowCount === 0) {
      await rollbackOrLog(client)
      return false
    }
    await client.query(`DELETE FROM chunks WHERE resource_id = $1`, [Id])
    await client.query('COMMIT')
    return true
  } catch (err) {
    await rollbackOrLog(client)
    throw err
  } finally {
    client.release()
  }
}

// 恢复：只接软删行；清 deleted_at 后回到 uploaded，等调用方重新 ingest。chunks 已在软删事务里删过，这里再清一次兜底
async function restoreResource(Db: Pool, Id: string): Promise<Resource | null> {
  const client = await Db.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `UPDATE resources
          SET deleted_at = NULL, status = 'uploaded', error_reason = NULL, updated_at = now()
        WHERE id = $1 AND deleted_at IS NOT NULL
        RETURNING *`,
      [Id],
    )
    if (rows.length === 0) {
      await rollbackOrLog(client)
      return null
    }
    await client.query(`DELETE FROM chunks WHERE resource_id = $1`, [Id])
    await client.query('COMMIT')
    return rowToResource(rows[0])
  } catch (err) {
    await rollbackOrLog(client)
    throw err
  } finally {
    client.release()
  }
}

// 资源状态计数：已软删的不算；未知枚举归 other，与状态分布卡同一口径。
async function resourceCounts(Db: Pool): Promise<ResourceCounts> {
  const { rows } = await Db.query(
    `SELECT status, COUNT(*)::int AS count
       FROM resources
      WHERE deleted_at IS NULL
      GROUP BY status`,
  )
  const Counts: ResourceCounts = {
    uploading: 0, uploaded: 0, processing: 0, ready: 0, upload_failed: 0, process_failed: 0, other: 0, total: 0,
  }
  for (const Row of rows) {
    const Count = Number(Row.count)
    Counts.total += Count
    switch (String(Row.status)) {
      case 'uploading':
        Counts.uploading += Count
        break
      case 'uploaded':
        Counts.uploaded += Count
        break
      case 'processing':
        Counts.processing += Count
        break
      case 'ready':
        Counts.ready += Count
        break
      case 'upload_failed':
        Counts.upload_failed += Count
        break
      case 'process_failed':
        Counts.process_failed += Count
        break
      default:
        Counts.other += Count
    }
  }
  return Counts
}

// 启动清扫：上次进程留下的 processing → process_failed（chunks 删）；超过 24h 的 uploading → upload_failed。
// 由 bootstrap 在监听前调用一次，不在路由里、不在能力片里散着写（AD-7）。
async function markStaleOnBoot(Db: Pool): Promise<{ resources: number; uploads: number }> {
  const client = await Db.connect()
  try {
    await client.query('BEGIN')

    const { rows: processingRows } = await client.query(
      `SELECT id FROM resources WHERE status = 'processing' AND deleted_at IS NULL`,
    )
    const processingIds: string[] = processingRows.map((r) => r.id as string)
    if (processingIds.length > 0) {
      await client.query(`DELETE FROM chunks WHERE resource_id = ANY($1::uuid[])`, [processingIds])
      await client.query(
        `UPDATE resources SET status = 'process_failed', error_reason = '入库中断', updated_at = now()
          WHERE id = ANY($1::uuid[])`,
        [processingIds],
      )
    }

    const { rows: uploadingRows } = await client.query(
      `SELECT id FROM resources
        WHERE status = 'uploading' AND deleted_at IS NULL AND updated_at < now() - interval '24 hours'`,
    )
    const uploadingIds: string[] = uploadingRows.map((r) => r.id as string)
    if (uploadingIds.length > 0) {
      await client.query(`DELETE FROM chunks WHERE resource_id = ANY($1::uuid[])`, [uploadingIds])
      await client.query(
        `UPDATE resources SET status = 'upload_failed', error_reason = '上传未完成', updated_at = now()
          WHERE id = ANY($1::uuid[])`,
        [uploadingIds],
      )
    }

    await client.query('COMMIT')
    return { resources: processingIds.length, uploads: uploadingIds.length }
  } catch (err) {
    await rollbackOrLog(client)
    throw err
  } finally {
    client.release()
  }
}

// 别用回滚自身的错顶掉真因
function rollbackOrLog(Client: PoolClient): Promise<unknown> {
  return Client.query('ROLLBACK').catch((rbErr) =>
    logError('E_ROLLBACK', String(rbErr)),
  )
}
