import { createDbPool } from './src/adapters/paradedb'
import { ParadeDbRepository } from './src/adapters/paradedb-repository'

function peek(Label: string, Value: unknown) {
  console.log(Label, JSON.stringify(Value))
}

async function main() {
  const pool = createDbPool(process.env.DATABASE_URL!)
  const repo = new ParadeDbRepository(pool)

  async function countEmbeddings(ChunkIds: string[]): Promise<number> {
    if (ChunkIds.length === 0) return 0
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM embeddings WHERE source_id = ANY($1::uuid[])`,
      [ChunkIds],
    )
    return rows[0].n as number
  }

  const resource = await repo.createResource({
    title: '软删探针',
    source: null,
    data_uri: `urn:kc:paste:${globalThis.crypto.randomUUID()}`,
    content_type: 'markdown',
    status: 'ready',
  })

  const vec = new Array(1024).fill(0.1)
  await repo.writeChunksWithEmbeddings(
    resource.id,
    [
      { chunk_index: 0, content: '第一段正文，用于验证软删把检索数据一起带走。', start_offset: 0, end_offset: 24 },
      { chunk_index: 1, content: '第二段正文，同样应该随 chunks 物理消失。', start_offset: 24, end_offset: 48 },
    ],
    [
      { dimension: 1024, model: 'probe', embedding: vec },
      { dimension: 1024, model: 'probe', embedding: vec },
    ],
  )

  const { rows: chunkRows } = await pool.query('SELECT id FROM chunks WHERE resource_id = $1', [resource.id])
  const chunkIds: string[] = chunkRows.map((r: { id: string }) => r.id)

  peek('before', {
    chunks: chunkIds.length,
    embeddings: await countEmbeddings(chunkIds),
    inList: (await repo.listResources()).some((r) => r.id === resource.id),
  })

  peek('firstDelete', await repo.softDeleteResource(resource.id))

  const { rows } = await pool.query('SELECT deleted_at FROM resources WHERE id = $1', [resource.id])
  peek('after', {
    deleted_at: rows[0].deleted_at instanceof Date ? 'set' : String(rows[0].deleted_at),
    chunksLeft: (await pool.query('SELECT 1 FROM chunks WHERE resource_id = $1', [resource.id])).rowCount,
    embeddingsLeft: await countEmbeddings(chunkIds),
    inList: (await repo.listResources()).some((r) => r.id === resource.id),
    chunksEndpoint: (await repo.getChunksByResource(resource.id)).length,
  })

  peek('secondDelete', await repo.softDeleteResource(resource.id))
  peek('unknownId', await repo.softDeleteResource(globalThis.crypto.randomUUID()))

  await pool.query('DELETE FROM resources WHERE id = $1', [resource.id])
  peek('probeRowRemoved', (await pool.query('SELECT 1 FROM resources WHERE id = $1', [resource.id])).rowCount)
  await pool.end()
}

main().catch((err) => {
  console.error('PROBE_FAILED', err)
  process.exit(1)
})
