/**
 * 代码库行 —— 独立 codebases 领域的读/写；与 resources 分离，不复用资源状态、去重或回收站。
 * 行只在 codebase 用例里建/改/删；HTTP 列表/详情由 routes/codebases.ts 手写，不走 hono-crud。
 * manifest 是扁平条目数组；树由 path 合成，正文不落库。全部走 Drizzle。
 * 列表、详情、状态检查与 markReady 回读都不取 manifest（CodebaseSummary）；只有树/文件读取用完整行。
 */

export {
  createCodebase, getCodebase, getCodebaseSummary, listCodebases, updateCodebaseStatus, markCodebaseReady, deleteCodebase,
  codebaseDataUriExists, markStaleCodebases,
}
export type { Codebase, CodebaseSummary, CodebaseStatus, CodebaseEntry }

import { and, count, desc, eq, ilike, lt, or, sql } from 'drizzle-orm'
import { codebases } from './orm/schema'
import type { Orm } from './orm/client'

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

type CodebaseSummary = Omit<Codebase, 'manifest'>

const CodebaseSummaryColumns = {
  id: codebases.id,
  title: codebases.title,
  original_filename: codebases.original_filename,
  data_uri: codebases.data_uri,
  content_type: codebases.content_type,
  status: codebases.status,
  error_reason: codebases.error_reason,
  storage_size_bytes: codebases.storage_size_bytes,
  file_count: codebases.file_count,
  declared_uncompressed_bytes: codebases.declared_uncompressed_bytes,
  created_at: codebases.created_at,
  updated_at: codebases.updated_at,
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

function rowToCodebaseSummary(r: any): CodebaseSummary {
  return {
    id: r.id,
    title: r.title,
    original_filename: r.original_filename,
    data_uri: r.data_uri,
    content_type: r.content_type,
    status: r.status,
    error_reason: r.error_reason,
    storage_size_bytes: r.storage_size_bytes == null ? null : Number(r.storage_size_bytes),
    file_count: Number(r.file_count),
    declared_uncompressed_bytes: Number(r.declared_uncompressed_bytes),
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  }
}

async function createCodebase(
  Db: Orm,
  Data: Pick<Codebase, 'title' | 'original_filename' | 'data_uri' | 'content_type' | 'status'>,
): Promise<Codebase> {
  const rows = await Db.insert(codebases).values({
    title: Data.title,
    original_filename: Data.original_filename,
    data_uri: Data.data_uri,
    content_type: Data.content_type,
    status: Data.status,
  }).returning()
  return rowToCodebase(rows[0])
}

async function getCodebase(Db: Orm, Id: string): Promise<Codebase | null> {
  const rows = await Db.select().from(codebases).where(eq(codebases.id, Id)).limit(1)
  return rows[0] ? rowToCodebase(rows[0]) : null
}

async function getCodebaseSummary(Db: Orm, Id: string): Promise<CodebaseSummary | null> {
  const rows = await Db.select(CodebaseSummaryColumns).from(codebases).where(eq(codebases.id, Id)).limit(1)
  return rows[0] ? rowToCodebaseSummary(rows[0]) : null
}

async function listCodebases(
  Db: Orm,
  Offset: number,
  Limit: number,
  Search: string,
): Promise<{ Items: CodebaseSummary[]; TotalCount: number }> {
  const Pattern = Search === '' ? undefined : `%${Search}%`
  const Where = Pattern === undefined
    ? undefined
    : or(ilike(codebases.title, Pattern), ilike(codebases.original_filename, Pattern))
  const rows = await Db.select(CodebaseSummaryColumns)
    .from(codebases)
    .where(Where)
    .orderBy(desc(codebases.created_at), desc(codebases.id))
    .limit(Limit)
    .offset(Offset)
  const CountRows = await Db.select({ total: count() }).from(codebases).where(Where)
  return { Items: rows.map(rowToCodebaseSummary), TotalCount: CountRows[0]!.total }
}

async function updateCodebaseStatus(
  Db: Orm,
  Id: string,
  Status: CodebaseStatus,
  Reason?: string,
): Promise<boolean> {
  const rows = await Db.update(codebases)
    .set({ status: Status, error_reason: Reason ?? null, updated_at: sql`now()` })
    .where(eq(codebases.id, Id))
    .returning({ id: codebases.id })
  return rows.length === 1
}

async function markCodebaseReady(
  Db: Orm,
  Id: string,
  Data: Pick<Codebase, 'storage_size_bytes' | 'manifest' | 'file_count' | 'declared_uncompressed_bytes'>,
): Promise<CodebaseSummary | null> {
  const rows = await Db.update(codebases)
    .set({
      status: 'ready',
      error_reason: null,
      storage_size_bytes: Data.storage_size_bytes,
      manifest: Data.manifest,
      file_count: Data.file_count,
      declared_uncompressed_bytes: Data.declared_uncompressed_bytes,
      updated_at: sql`now()`,
    })
    .where(eq(codebases.id, Id))
    .returning(CodebaseSummaryColumns)
  return rows[0] ? rowToCodebaseSummary(rows[0]) : null
}

async function deleteCodebase(Db: Orm, Id: string): Promise<CodebaseSummary | null> {
  const rows = await Db.delete(codebases).where(eq(codebases.id, Id)).returning(CodebaseSummaryColumns)
  return rows[0] ? rowToCodebaseSummary(rows[0]) : null
}

async function codebaseDataUriExists(Db: Orm, Uri: string): Promise<boolean> {
  const rows = await Db.select({ id: codebases.id }).from(codebases).where(eq(codebases.data_uri, Uri)).limit(1)
  return rows.length > 0
}

// 启动清扫：上次进程留下的校验中行转 failed；超 24h 的 uploading 转 failed。
async function markStaleCodebases(Db: Orm): Promise<{ processing: number; uploads: number }> {
  const Processing = await Db.update(codebases)
    .set({ status: 'failed', error_reason: '校验中断', updated_at: sql`now()` })
    .where(eq(codebases.status, 'processing'))
    .returning({ id: codebases.id })
  const Uploads = await Db.update(codebases)
    .set({ status: 'failed', error_reason: '上传未完成', updated_at: sql`now()` })
    .where(and(
      eq(codebases.status, 'uploading'),
      lt(codebases.updated_at, sql`now() - interval '24 hours'`),
    ))
    .returning({ id: codebases.id })
  return { processing: Processing.length, uploads: Uploads.length }
}
