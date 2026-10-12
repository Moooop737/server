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

    // ── Chunk ──

    async createChunks(
        resourceId: string,
        chunks: Pick<Chunk, 'chunk_index' | 'content' | 'start_offset' | 'end_offset'>[],
    ): Promise<Chunk[]> {
        if (chunks.length === 0) return []
        // 先拿 resource_uri（chunks 表 NOT NULL；端口签名不传此值）
        const { rows: [res] } = await this.pool.query(
            `SELECT data_uri FROM resources WHERE id = $1`,
            [resourceId],
        )
        const resourceUri = res.data_uri as string

        // 批量 INSERT：动态拼 VALUES 段
        const values: string[] = []
        const params: any[] = []
        let i = 1
        for (const c of chunks) {
            values.push(`($${i}, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5})`)
            params.push(resourceId, resourceUri, c.chunk_index, c.content, c.start_offset, c.end_offset)
            i += 6
        }
        const { rows } = await this.pool.query(
            `INSERT INTO chunks (resource_id, resource_uri, chunk_index, content, start_offset, end_offset)
       VALUES ${values.join(',')}
       RETURNING *`,
            params,
        )
        return rows.map(rowToChunk)
    }

    // ── Embedding ──

    async createEmbeddings(
        embeddings: Pick<Embedding, 'source_id' | 'source_type' | 'dimension' | 'model' | 'embedding'>[],
    ): Promise<void> {
        if (embeddings.length === 0) return
        const values: string[] = []
        const params: any[] = []
        let i = 1
        for (const e of embeddings) {
            values.push(`($${i}, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}::halfvec)`)
            params.push(e.source_id, e.source_type, e.dimension, e.model, vecToHalfvecStr(e.embedding))
            i += 5
        }
        await this.pool.query(
            `INSERT INTO embeddings (source_id, source_type, dimension, model, embedding)
       VALUES ${values.join(',')}
       ON CONFLICT DO NOTHING`,
            params,
        )
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

    // ── 后续 Story 的方法先占位 ──

    async softDeleteResource(_id: string): Promise<void> {
        throw new Error('NotImplemented: softDeleteResource (Story 1.4)')
    }
    async findResourcesByStatus(_status: Resource['status']): Promise<Resource[]> {
        throw new Error('NotImplemented: findResourcesByStatus (Story 1.4/cleanup)')
    }
    async deleteEmbeddingsByResource(_resourceId: string): Promise<void> {
        throw new Error('NotImplemented: deleteEmbeddingsByResource (Story 1.4)')
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