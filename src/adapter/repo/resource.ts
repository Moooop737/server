/**
 * 资源功能 —— 资源行的读/写：getResource、建行、改状态/标题、软删、启动清扫。
 * list/read 的 HTTP 投影由 routes/crud.ts 统一注册到 hono-crud；这里保留自定义写路径与 getResource。
 * getResource 走 Drizzle；其余仍是 pg 裸 SQL。每条 UPDATE 都带 deleted_at IS NULL。
 * softDeleteResource 与 chunk.ts 的 deleteChunksByResource 故意不合并：前者在软删事务内，后者是无事务单语句清理。
 */

export {
  createResource, updateResourceStatus, updateResourceTitle, softDeleteResource, markInterruptedAsFailed,
  getResource, findActiveBySource,
}
export type { Resource }

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

interface Resource extends timestamp {
  id: string
  title: string
  source: string | null
  data_uri: string
  content_type: 'url' | 'markdown' | 'plaintext'
  status: 'processing' | 'ready' | 'failed'
  error_reason: string | null
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

async function findActiveBySource(Db: Pool, Url: string): Promise<Resource | null> {
  const { rows } = await Db.query(
    `SELECT * FROM resources
       WHERE source = $1 AND status IN ('ready', 'processing') AND deleted_at IS NULL
       LIMIT 1`,
    [Url],
  )
  return rows[0] ? rowToResource(rows[0]) : null
}

async function createResource(
  Db: Pool,
  Data: Pick<Resource, 'title' | 'source' | 'data_uri' | 'content_type'> & Partial<Pick<Resource, 'status'>>,
): Promise<Resource> {
  const status = Data.status ?? 'processing'
  const { rows } = await Db.query(
    `INSERT INTO resources (title, source, data_uri, content_type, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
    [Data.title, Data.source, Data.data_uri, Data.content_type, status],
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

// 启动清扫：上一次进程被杀掉时留在 processing 的资源，chunks 物理删、行转 failed(入库中断)。
// 由 bootstrap 在监听前调用一次，不在路由里、不在能力片里散着写（AD-7）。
async function markInterruptedAsFailed(Db: Pool): Promise<{ resources: number }> {
  const client = await Db.connect()
  try {
    await client.query('BEGIN')

    const { rows } = await client.query(
      `SELECT id FROM resources WHERE status = 'processing' AND deleted_at IS NULL`,
    )
    const ids: string[] = rows.map((r) => r.id as string)

    if (ids.length > 0) {
      await client.query(`DELETE FROM chunks WHERE resource_id = ANY($1::uuid[])`, [ids])
      await client.query(
        `UPDATE resources SET status = 'failed', error_reason = '入库中断', updated_at = now() WHERE id = ANY($1::uuid[])`,
        [ids],
      )
    }

    await client.query('COMMIT')
    return { resources: ids.length }
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
