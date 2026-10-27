/**
 * 代码库行 —— 独立 codebases 领域的读/写；与 resources 分离，不复用资源状态、去重或回收站。
 * 行只在 codebase 用例里建/改/删；HTTP 列表/详情由 routes/codebases.ts 手写，不走 hono-crud。
 * manifest 是扁平条目数组；树由 path 合成，正文不落库。
 */

export {
  createCodebase, getCodebase, listCodebases, updateCodebaseStatus, markCodebaseReady, deleteCodebase,
  codebaseDataUriExists, markStaleCodebases,
}
export type { Codebase, CodebaseStatus, CodebaseEntry }

import type { Pool } from 'pg'

type CodebaseStatus = 'uploading' | 'processing' | 'ready' | 'failed'

interface CodebaseEntry {
  path: string
  entry_index: number
  is_dir: boolean
  compressed_size: number
  uncompressed_size: number
  compression_method: number
}

interface Codebase {
  id: string
  title: string
  original_filename: string
  data_uri: string
  content_type: string
  status: CodebaseStatus
  error_reason: string | null
  storage_size_bytes: number | null
  manifest: CodebaseEntry[]
  file_count: number
  declared_uncompressed_bytes: number
  created_at: string
  updated_at: string
}

function iso(v: Date | null): string | null {
  return v === null ? null : v.toISOString()
}

function rowToCodebase(r: any): Codebase {
  return {
    id: r.id,
    title: r.title,
    original_filename: r.original_filename,
    data_uri: r.data_uri,
    content_type: r.content_type,
    status: r.status,
    error_reason: r.error_reason,
    storage_size_bytes: r.storage_size_bytes == null ? null : Number(r.storage_size_bytes),
    manifest: Array.isArray(r.manifest) ? r.manifest : [],
    file_count: Number(r.file_count),
    declared_uncompressed_bytes: Number(r.declared_uncompressed_bytes),
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  }
}

async function createCodebase(
  Db: Pool,
  Data: Pick<Codebase, 'title' | 'original_filename' | 'data_uri' | 'content_type' | 'status'>,
): Promise<Codebase> {
  const { rows } = await Db.query(
    `INSERT INTO codebases (title, original_filename, data_uri, content_type, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
    [Data.title, Data.original_filename, Data.data_uri, Data.content_type, Data.status],
  )
  return rowToCodebase(rows[0])
}

async function getCodebase(Db: Pool, Id: string): Promise<Codebase | null> {
  const { rows } = await Db.query(`SELECT * FROM codebases WHERE id = $1`, [Id])
  return rows[0] ? rowToCodebase(rows[0]) : null
}

async function listCodebases(
  Db: Pool,
  Offset: number,
  Limit: number,
  Search: string,
): Promise<{ Items: Codebase[]; TotalCount: number }> {
  const Pattern = Search === '' ? null : `%${Search}%`
  const { rows } = await Db.query(
    `SELECT * FROM codebases
      WHERE ($3::text IS NULL OR title ILIKE $3 OR original_filename ILIKE $3)
      ORDER BY created_at DESC, id DESC
      LIMIT $1 OFFSET $2`,
    [Limit, Offset, Pattern],
  )
  const { rows: CountRows } = await Db.query(
    `SELECT COUNT(*)::int AS n FROM codebases
      WHERE ($1::text IS NULL OR title ILIKE $1 OR original_filename ILIKE $1)`,
    [Pattern],
  )
  return { Items: rows.map(rowToCodebase), TotalCount: Number(CountRows[0]!.n) }
}

async function updateCodebaseStatus(
  Db: Pool,
  Id: string,
  Status: CodebaseStatus,
  Reason?: string,
): Promise<boolean> {
  const { rowCount } = await Db.query(
    `UPDATE codebases SET status = $2, error_reason = $3, updated_at = now() WHERE id = $1`,
    [Id, Status, Reason ?? null],
  )
  return rowCount === 1
}

async function markCodebaseReady(
  Db: Pool,
  Id: string,
  Data: Pick<Codebase, 'storage_size_bytes' | 'manifest' | 'file_count' | 'declared_uncompressed_bytes'>,
): Promise<Codebase | null> {
  const { rows } = await Db.query(
    `UPDATE codebases
        SET status = 'ready', error_reason = NULL, storage_size_bytes = $2,
            manifest = $3::jsonb, file_count = $4, declared_uncompressed_bytes = $5, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [Id, Data.storage_size_bytes, JSON.stringify(Data.manifest), Data.file_count, Data.declared_uncompressed_bytes],
  )
  return rows[0] ? rowToCodebase(rows[0]) : null
}

async function deleteCodebase(Db: Pool, Id: string): Promise<Codebase | null> {
  const { rows } = await Db.query(`DELETE FROM codebases WHERE id = $1 RETURNING *`, [Id])
  return rows[0] ? rowToCodebase(rows[0]) : null
}

async function codebaseDataUriExists(Db: Pool, Uri: string): Promise<boolean> {
  const { rows } = await Db.query(`SELECT 1 FROM codebases WHERE data_uri = $1 LIMIT 1`, [Uri])
  return rows.length > 0
}

// 启动清扫：上次进程留下的校验中行转 failed；超 24h 的 uploading 转 failed。
async function markStaleCodebases(Db: Pool): Promise<{ processing: number; uploads: number }> {
  const Processing = await Db.query(
    `UPDATE codebases
        SET status = 'failed', error_reason = '校验中断', updated_at = now()
      WHERE status = 'processing'`,
  )
  const Uploads = await Db.query(
    `UPDATE codebases
        SET status = 'failed', error_reason = '上传未完成', updated_at = now()
      WHERE status = 'uploading' AND updated_at < now() - interval '24 hours'`,
  )
  return { processing: Processing.rowCount ?? 0, uploads: Uploads.rowCount ?? 0 }
}
