/**
 * 资源行的写 —— 建行、改状态、改标题、软删、启动清扫。SQL 住本层，触发者仍是 ingest 与 bootstrap（AD-7：状态只有一个写入者）。
 * 每条 UPDATE 都带 `AND deleted_at IS NULL`：已软删的行不留痕、也不被改回 ready。
 * softDeleteResource 与 write-content 的 deleteChunksByResource 都各有一句 `DELETE FROM chunks`，故意不合并：
 * 前者在软删事务内（与 resources 的 deleted_at 同笔提交），后者是无事务的单语句清理，语义与失败面都不同。
 */

export { createResource, updateResourceStatus, updateResourceTitle, softDeleteResource, markInterruptedAsFailed }

import type { Pool, PoolClient } from 'pg'
import type { Resource } from '../../types/types'
import { rowToResource } from './read-content'

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
    console.error(JSON.stringify({ code: 'E_ROLLBACK', message: String(rbErr) })),
  )
}
