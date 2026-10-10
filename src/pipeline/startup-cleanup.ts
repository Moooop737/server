import type { Pool } from 'pg'

export interface CleanupResult {
  resources: number
}

// 启动清扫：把上次中断遗留在 processing 的资源转为 failed，并删其残余 Chunk。
// embeddings 经 FK ON DELETE CASCADE 随 chunk 删除，无孤儿向量。整体事务，避免竞态。
export async function cleanupInterruptedIngest(pool: Pool): Promise<CleanupResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows } = await client.query(
      `SELECT id FROM resources WHERE status = 'processing' AND deleted_at IS NULL`,
    )
    const ids: string[] = rows.map((r) => r.id as string)

    if (ids.length > 0) {
      // 删 chunk → 级联删 embedding（无孤儿向量）
      await client.query(`DELETE FROM chunks WHERE resource_id = ANY($1::uuid[])`, [ids])
      await client.query(
        `UPDATE resources
           SET status = 'failed', error_reason = '入库中断', updated_at = now()
         WHERE id = ANY($1::uuid[])`,
        [ids],
      )
    }

    await client.query('COMMIT')
    return { resources: ids.length }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
