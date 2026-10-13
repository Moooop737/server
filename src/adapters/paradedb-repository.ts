import type { Pool } from 'pg'
import type { Repository } from '../ports/repository'
import type { Resource, Chunk, Embedding, Session, Message } from '../types/types'

// ─── 工具函数：把 pg 的行 → 我们的 types（契约层） ───

/** Date → ISO string; null → null */
function iso(v: Date | string | null): string | null {
    if (v === null) return null
    return v instanceof Date ? v.toISOString() : v
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

// ─── halfvec 序列化 ───

/** number[] → pg halfvec 字面量字符串 '[0.1,0.2,...]' */
function vecToHalfvecStr(v: number[]): string {
    return `[${v.join(',')}]`
}

// ─── Repository 适配器 ───

export class ParadeDbRepository implements Repository {
    constructor(private pool: Pool) { }

    // ── Resource ──

    async createResource(
        data: Pick<Resource, 'title' | 'source' | 'data_uri' | 'content_type'> &
            Partial<Pick<Resource, 'status'>>
    ): Promise<Resource> {
        const status = data.status ?? 'processing'
        const { rows } = await this.pool.query(
            `INSERT INTO resources (title, source, data_uri, content_type, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
            [data.title, data.source, data.data_uri, data.content_type, status],
        )
        return rowToResource(rows[0])
    }

    async getResource(id: string): Promise<Resource | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM resources WHERE id = $1 AND deleted_at IS NULL`,
            [id],
        )
        return rows[0] ? rowToResource(rows[0]) : null
    }

    async updateResourceStatus(
        id: string,
        status: Resource['status'],
        reason?: string,
    ): Promise<void> {
        await this.pool.query(
            `UPDATE resources SET status = $2, error_reason = $3, updated_at = now() WHERE id = $1`,
            [id, status, reason ?? null],
        )
    }

    async updateResourceTitle(Id: string, Title: string): Promise<void> {
        await this.pool.query(
            `UPDATE resources SET title = $2, updated_at = now() WHERE id = $1`,
            [Id, Title],
        )
    }

    async findActiveBySource(Url: string): Promise<Resource | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM resources
       WHERE source = $1 AND status IN ('ready', 'processing') AND deleted_at IS NULL
       LIMIT 1`,
            [Url],
        )
        return rows[0] ? rowToResource(rows[0]) : null
    }

    // ── Chunk + Embedding + ready（同一事务）──

    // chunk、向量、状态迁移同事务：要么全写、要么全滚，既杜绝「有 chunk 无向量」，也杜绝「向量已落、行还 processing」
    async writeChunksWithEmbeddings(
        ResourceId: string,
        Chunks: Pick<Chunk, 'chunk_index' | 'content' | 'start_offset' | 'end_offset'>[],
        Vectors: Pick<Embedding, 'dimension' | 'model' | 'embedding'>[],
    ): Promise<number> {
        if (Chunks.length === 0) return 0
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')

            const { rows: [res] } = await client.query(
                `SELECT data_uri FROM resources WHERE id = $1`,
                [ResourceId],
            )
            const resourceUri = res.data_uri as string

            const cValues: string[] = []
            const cParams: any[] = []
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
            const eParams: any[] = []
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

            await client.query(
                `UPDATE resources SET status = 'ready', error_reason = NULL, updated_at = now() WHERE id = $1`,
                [ResourceId],
            )

            await client.query('COMMIT')
            return Chunks.length
        } catch (err) {
            await client.query('ROLLBACK').catch((rbErr) =>
                console.error(JSON.stringify({ code: 'E_ROLLBACK', message: String(rbErr) })),
            ) // 别用回滚自身的错顶掉真因
            throw err
        } finally {
            client.release()
        }
    }

    async listResources(): Promise<Resource[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM resources WHERE deleted_at IS NULL ORDER BY created_at DESC`,
        )
        return rows.map(rowToResource)
    }

    // 删 chunk；embedding 经 FK source_id→chunks.id ON DELETE CASCADE 随之删除，无孤儿向量
    async deleteChunksByResource(resourceId: string): Promise<void> {
        await this.pool.query(`DELETE FROM chunks WHERE resource_id = $1`, [resourceId])
    }

    async getChunksByResource(resourceId: string): Promise<Chunk[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM chunks WHERE resource_id = $1 AND deleted_at IS NULL ORDER BY chunk_index`,
            [resourceId],
        )
        return rows.map(rowToChunk)
    }

    // 软删：resources 行留痕（deleted_at），检索数据物理移除（chunks → embeddings 经 FK CASCADE 一起走）
    // 返回 false = 该行不存在或早已软删，交调用方决定怎么报
    async softDeleteResource(Id: string): Promise<boolean> {
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            const { rowCount } = await client.query(
                `UPDATE resources SET deleted_at = now(), updated_at = now()
                 WHERE id = $1 AND deleted_at IS NULL`,
                [Id],
            )
            if (rowCount === 0) {
                await client.query('ROLLBACK').catch((rbErr) =>
                    console.error(JSON.stringify({ code: 'E_ROLLBACK', message: String(rbErr) })),
                )
                return false
            }
            await client.query(`DELETE FROM chunks WHERE resource_id = $1`, [Id])
            await client.query('COMMIT')
            return true
        } catch (err) {
            await client.query('ROLLBACK').catch((rbErr) =>
                console.error(JSON.stringify({ code: 'E_ROLLBACK', message: String(rbErr) })),
            )
            throw err
        } finally {
            client.release()
        }
    }

    // ── 后续 Story 的方法先占位 ──

    async findResourcesByStatus(_status: Resource['status']): Promise<Resource[]> {
        throw new Error('NotImplemented: findResourcesByStatus (Story 1.4/cleanup)')
    }
    async createSession(_title?: string): Promise<Session> {
        throw new Error('NotImplemented: createSession (Story 2.1)')
    }
    async getSession(_id: string): Promise<Session | null> {
        throw new Error('NotImplemented: getSession (Story 2.1)')
    }
    async createMessage(_data: any): Promise<Message> {
        throw new Error('NotImplemented: createMessage (Story 2.1)')
    }
    async getMessagesBySession(_sessionId: string): Promise<Message[]> {
        throw new Error('NotImplemented: getMessagesBySession (Story 2.1)')
    }
}
