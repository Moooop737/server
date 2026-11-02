/**
 * 资源功能 —— 资源行的读/写：getResource/getResourceIncludingDeleted、建行、改状态/标题/存储大小、软删/恢复、启动清扫。
 * list/read 的 HTTP 投影由 routes/crud.ts 统一注册到 hono-crud；这里保留自定义写路径与 getResource。
 * 除 listResourcesByUriSuffix 的 right/length 表达式与事务里的 chunks 物理删除外，全部走 Drizzle。
 * 除恢复外，每条 UPDATE 都带 deleted_at IS NULL。
 * softDeleteResource 与 chunk.ts 的 deleteChunksByResource 故意不合并：前者在软删事务内，后者是无事务单语句清理。
 */

export {
  createResource, updateResourceStatus, updateResourceTitle, softDeleteResource, markResourceUploaded, restoreResource,
  getResource, getResourceIncludingDeleted, getResourceByContentHash, findActiveBySource, dataUriExists, resourceCounts, markStaleOnBoot,
  listDeletedResources, purgeResource, listResourcesByUriSuffix, searchResources
}
export type { Resource, ResourceStatus, ResourceCounts }

import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { resources } from './orm/schema'
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

async function findActiveBySource(Db: Orm, Url: string): Promise<Resource | null> {
  const rows = await Db.select()
    .from(resources)
    .where(and(
      eq(resources.source, Url),
      inArray(resources.status, ['uploading', 'uploaded', 'processing', 'ready']),
      isNull(resources.deleted_at),
    ))
    .limit(1)
  return rows[0] ? rowToResource(rows[0]) : null
}

// 题集 gold 解析用：按 data_uri 后缀精确匹配 ready 资源（不用 LIKE，路径里的 _ / % 不当通配符）；命中多条由调用方判失败
async function listResourcesByUriSuffix(Db: Pool, Suffix: string): Promise<Resource[]> {
  const { rows } = await Db.query(
    `SELECT * FROM resources
       WHERE status = 'ready' AND deleted_at IS NULL AND right(data_uri, length($1) + 1) = '/' || $1
       ORDER BY data_uri ASC`,
    [Suffix],
  )
  return rows.map(rowToResource)
}

async function getResourceByContentHash(Db: Orm, Hash: string): Promise<Resource | null> {
  const rows = await Db.select()
    .from(resources)
    .where(eq(resources.content_hash, Hash))
    .limit(1)
  return rows[0] ? rowToResource(rows[0]) : null
}

const DELETED_SORT_COLUMNS = {
  created_at: resources.created_at,
  updated_at: resources.updated_at,
  deleted_at: resources.deleted_at,
  title: resources.title,
  status: resources.status,
}

async function listDeletedResources(
  Db: Orm,
  Offset: number,
  Limit: number,
  Search: string,
  Sort = 'deleted_at',
  Order: 'asc' | 'desc' = 'desc',
): Promise<{ Items: Resource[]; TotalCount: number }> {
  const Pattern = Search === '' ? undefined : `%${Search}%`
  const Column = DELETED_SORT_COLUMNS[Sort as keyof typeof DELETED_SORT_COLUMNS] ?? resources.deleted_at
  const Direction = Order === 'asc' ? asc : desc
  const Where = and(
    isNotNull(resources.deleted_at),
    Pattern === undefined ? undefined : or(ilike(resources.title, Pattern), ilike(resources.source, Pattern)),
  )
  const rows = await Db.select()
    .from(resources)
    .where(Where)
    .orderBy(Direction(Column), desc(resources.id))
    .limit(Limit)
    .offset(Offset)
  const CountRows = await Db.select({ total: count() }).from(resources).where(Where)
  return { Items: rows.map(rowToResource), TotalCount: CountRows[0]!.total }
}

// 彻底删除：只接软删行；chunks/embeddings 经外键 CASCADE 一起走，content_hash 随行释放
async function purgeResource(Db: Orm, Id: string): Promise<Resource | null> {
  const rows = await Db.delete(resources)
    .where(and(eq(resources.id, Id), isNotNull(resources.deleted_at)))
    .returning()
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
  Db: Orm,
  Data: Pick<Resource, 'title' | 'source' | 'data_uri' | 'content_type' | 'status'>
    & Partial<Pick<Resource, 'storage_size_bytes' | 'content_hash'>>,
): Promise<Resource> {
  const rows = await Db.insert(resources).values({
    title: Data.title,
    source: Data.source,
    data_uri: Data.data_uri,
    content_type: Data.content_type,
    status: Data.status,
    storage_size_bytes: Data.storage_size_bytes ?? null,
    content_hash: Data.content_hash ?? null,
  }).returning()
  return rowToResource(rows[0])
}

async function updateResourceStatus(
  Db: Orm,
  Id: string,
  Status: Resource['status'],
  Reason?: string,
): Promise<void> {
  await Db.update(resources)
    .set({ status: Status, error_reason: Reason ?? null, updated_at: sql`now()` })
    .where(and(eq(resources.id, Id), isNull(resources.deleted_at)))
}

async function updateResourceTitle(Db: Orm, Id: string, Title: string): Promise<void> {
  await Db.update(resources)
    .set({ title: Title, updated_at: sql`now()` })
    .where(and(eq(resources.id, Id), isNull(resources.deleted_at)))
}

// 上传成功的唯一状态落点：对象已 stat 到、大小已确认；允许从 uploading/uploaded/upload_failed/process_failed/ready 重试
async function markResourceUploaded(Db: Orm, Id: string, Size: number, ContentType?: string): Promise<boolean> {
  const rows = await Db.update(resources)
    .set({
      status: 'uploaded',
      storage_size_bytes: Size,
      error_reason: null,
      ...(ContentType != null ? { content_type: ContentType } : {}),
      updated_at: sql`now()`,
    })
    .where(and(
      eq(resources.id, Id),
      isNull(resources.deleted_at),
      inArray(resources.status, ['uploading', 'uploaded', 'upload_failed', 'process_failed', 'ready']),
    ))
    .returning({ id: resources.id })
  return rows.length === 1
}

// 软删：resources 行留痕（deleted_at），检索数据物理移除（chunks → embeddings 经 FK CASCADE 一起走）
// 返回 false = 该行不存在或早已软删，交调用方决定怎么报
async function softDeleteResource(Db: Orm, Id: string): Promise<boolean> {
  return Db.transaction(async (Tx) => {
    const rows = await Tx.update(resources)
      .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
      .where(and(eq(resources.id, Id), isNull(resources.deleted_at)))
      .returning({ id: resources.id })
    if (rows.length === 0) return false
    await Tx.execute(sql`DELETE FROM chunks WHERE resource_id = ${Id}`)
    return true
  })
}

// 恢复：只接软删行；清 deleted_at 后回到 uploaded，等调用方重新 ingest。chunks 已在软删事务里删过，这里再清一次兜底
async function restoreResource(Db: Orm, Id: string): Promise<Resource | null> {
  return Db.transaction(async (Tx) => {
    const rows = await Tx.update(resources)
      .set({ deleted_at: null, status: 'uploaded', error_reason: null, updated_at: sql`now()` })
      .where(and(eq(resources.id, Id), isNotNull(resources.deleted_at)))
      .returning()
    if (rows.length === 0) return null
    await Tx.execute(sql`DELETE FROM chunks WHERE resource_id = ${Id}`)
    return rowToResource(rows[0])
  })
}

// 资源状态计数：已软删的不算；未知枚举归 other，与状态分布卡同一口径。
async function resourceCounts(Db: Orm): Promise<ResourceCounts> {
  const rows = await Db.select({ status: resources.status, count: count() })
    .from(resources)
    .where(isNull(resources.deleted_at))
    .groupBy(resources.status)
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

async function searchResources(Db: Orm, Query: string, Limit: number): Promise<Resource[]> {
  const rows = await Db.select().from(resources).where(
    and(
      isNull(resources.deleted_at),
      or(
        sql`strpos(lower(${resources.title}), lower(${Query})) > 0`,
        sql`strpos(lower(coalesce(${resources.source}, '')), lower(${Query})) > 0`,
        sql`strpos(lower(${resources.data_uri}), lower(${Query})) > 0`,
      )
    )
  ).orderBy(desc(resources.created_at), desc(resources.id)).limit(Limit)
  return rows.map(rowToResource)
}

// 启动清扫：上次进程留下的 processing → process_failed（chunks 删）；超过 24h 的 uploading → upload_failed。
// 由 bootstrap 在监听前调用一次，不在路由里、不在能力片里散着写（AD-7）。
async function markStaleOnBoot(Db: Orm): Promise<{ resources: number; uploads: number }> {
  return Db.transaction(async (Tx) => {
    const Processing = await Tx.select({ id: resources.id })
      .from(resources)
      .where(and(eq(resources.status, 'processing'), isNull(resources.deleted_at)))
    const ProcessingIds = Processing.map((Row) => Row.id)
    if (ProcessingIds.length > 0) {
      await Tx.execute(sql`DELETE FROM chunks WHERE ${inArray(sql`resource_id`, ProcessingIds)}`)
      await Tx.update(resources)
        .set({ status: 'process_failed', error_reason: '入库中断', updated_at: sql`now()` })
        .where(inArray(resources.id, ProcessingIds))
    }

    const Uploading = await Tx.select({ id: resources.id })
      .from(resources)
      .where(and(
        eq(resources.status, 'uploading'),
        isNull(resources.deleted_at),
        lt(resources.updated_at, sql`now() - interval '24 hours'`),
      ))
    const UploadingIds = Uploading.map((Row) => Row.id)
    if (UploadingIds.length > 0) {
      await Tx.execute(sql`DELETE FROM chunks WHERE ${inArray(sql`resource_id`, UploadingIds)}`)
      await Tx.update(resources)
        .set({ status: 'upload_failed', error_reason: '上传未完成', updated_at: sql`now()` })
        .where(inArray(resources.id, UploadingIds))
    }

    return { resources: ProcessingIds.length, uploads: UploadingIds.length }
  })
}
