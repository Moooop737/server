/**
 * 代码库路由 —— 独立 /codebases 命名空间：上传目标、complete 校验、列表/详情、树、单文件预览/下载、原 ZIP 302、硬删。
 * 归档/校验在 CodebaseArchive，读侧在 CodebaseReader，硬删在 CodebasePurge；本路由只做参数与错误码映射。
 * 不碰资源域、不进 ingest、不注册 hono-crud。
 */

export { CodebasesRoute }

import 'reflect-metadata'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { inject, injectable } from 'tsyringe'
import { PostgresCodebaseRepo } from '../adapter/contract'
import type { Codebase, CodebaseRepo } from '../adapter/contract'
import { CodebaseArchive, CodebaseError } from '../codebase/archive'
import { CodebaseReader, CodebaseReadError } from '../codebase/reader'
import { CodebasePurge, CodebaseDeleteError } from '../codebase/purge'
import { logError } from '../trace/systemtrace/log'

@injectable()
class CodebasesRoute {
  private readonly repo: CodebaseRepo
  private readonly archive: CodebaseArchive
  private readonly reader: CodebaseReader
  private readonly purge: CodebasePurge

  constructor(
    @inject(PostgresCodebaseRepo) Repo: CodebaseRepo,
    @inject(CodebaseArchive) Archive: CodebaseArchive,
    @inject(CodebaseReader) Reader: CodebaseReader,
    @inject(CodebasePurge) Purge: CodebasePurge,
  ) {
    this.repo = Repo
    this.archive = Archive
    this.reader = Reader
    this.purge = Purge
  }

  build(): Hono {
    const app = new Hono()
    const repo = this.repo
    const archive = this.archive
    const reader = this.reader
    const purge = this.purge

    app.get('/', async (c) => {
      const PageRaw = c.req.query('page')
      const PerPageRaw = c.req.query('per_page')
      const Page = PageRaw === undefined ? 1 : Number(PageRaw)
      const PerPage = PerPageRaw === undefined ? 20 : Number(PerPageRaw)
      if (!Number.isInteger(Page) || Page < 1 || Page > 1_000_000 || !Number.isInteger(PerPage) || PerPage < 1 || PerPage > 100) {
        return c.json({ code: 'E_BAD_QUERY', message: 'page 需为 1-1000000 的整数，per_page 需为 1-100 的整数' }, 400)
      }
      const Search = (c.req.query('search') ?? '').trim().slice(0, 200)
      try {
        let First = await repo.listCodebases((Page - 1) * PerPage, PerPage, Search)
        const TotalPages = Math.ceil(First.TotalCount / PerPage)
        let ShownPage = Page
        if (First.Items.length === 0 && First.TotalCount > 0 && Page > 1) {
          ShownPage = Math.max(1, TotalPages)
          First = await repo.listCodebases((ShownPage - 1) * PerPage, PerPage, Search)
        }
        return c.json({
          codebases: First.Items.map(withoutManifest),
          pagination: { page: ShownPage, per_page: PerPage, total_count: First.TotalCount, total_pages: TotalPages },
        })
      } catch (err) {
        logError('E_CODEBASE_LIST', String(err))
        return c.json({ code: 'E_CODEBASE_LIST', message: '读取代码库列表失败' }, 500)
      }
    })

    app.get('/:id', async (c) => {
      const id = c.req.param('id')
      if (!uuidOk(id)) return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      try {
        const codebase = await repo.getCodebase(id)
        if (!codebase) return c.json({ code: 'E_NOT_FOUND', message: '代码库不存在' }, 404)
        return c.json({ codebase: withoutManifest(codebase) })
      } catch (err) {
        logError('E_CODEBASE_READ', String(err))
        return c.json({ code: 'E_CODEBASE_READ', message: '读取代码库失败' }, 500)
      }
    })

    app.get('/:id/tree', async (c) => {
      const id = c.req.param('id')
      if (!uuidOk(id)) return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      try {
        return c.json({ entries: await reader.tree(id) })
      } catch (err) {
        return mapReadError(c, err, 'E_CODEBASE_TREE', '读取代码库文件树失败')
      }
    })

    app.get('/:id/files/:entryIndex', async (c) => {
      const id = c.req.param('id')
      if (!uuidOk(id)) return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      const Raw = c.req.param('entryIndex')
      const EntryIndex = Number(Raw)
      if (!/^\d+$/.test(Raw) || !Number.isSafeInteger(EntryIndex)) {
        return c.json({ code: 'E_BAD_ENTRY', message: 'entryIndex 需为非负整数' }, 400)
      }

      try {
        const File = await reader.file(id, EntryIndex, c.req.query('download') === '1')
        return c.body(Readable.toWeb(File.stream) as unknown as ReadableStream, 200, {
          'Content-Type': File.contentType,
          'Content-Disposition': File.disposition,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        })
      } catch (err) {
        return mapReadError(c, err, 'E_CODEBASE_FILE', '读取代码库文件失败')
      }
    })

    app.get('/:id/original', async (c) => {
      const id = c.req.param('id')
      if (!uuidOk(id)) return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      try {
        const target = await reader.original(id)
        return c.body(null, 302, { Location: target.url, 'Cache-Control': 'no-store' })
      } catch (err) {
        return mapReadError(c, err, 'E_CODEBASE_DOWNLOAD', '生成代码库下载地址失败')
      }
    })

    app.delete('/:id', async (c) => {
      const id = c.req.param('id')
      if (!uuidOk(id)) return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      try {
        await purge.delete(id)
        return c.body(null, 204)
      } catch (err) {
        return mapDeleteError(c, err)
      }
    })

    app.post('/', async (c) => {
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ code: 'E_BAD_JSON', message: '请求体不是合法 JSON' }, 400)
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return c.json({ code: 'E_BAD_JSON', message: '请求体需为 JSON 对象' }, 400)
      }
      const B = body as { filename?: unknown; size?: unknown; title?: unknown }
      if (typeof B.filename !== 'string') {
        return c.json({ code: 'E_BAD_FILENAME', message: 'filename 必填且为字符串' }, 400)
      }
      if (B.size !== undefined && (typeof B.size !== 'number' || !Number.isInteger(B.size) || B.size < 0)) {
        return c.json({ code: 'E_BAD_SIZE', message: 'size 需为非负整数' }, 400)
      }
      if (B.title !== undefined && typeof B.title !== 'string') {
        return c.json({ code: 'E_BAD_BODY', message: 'title 需为字符串' }, 400)
      }

      try {
        const result = await archive.createUpload(B.filename, B.size as number | undefined, B.title as string | undefined)
        return c.json(result, 201)
      } catch (err) {
        return mapError(c, err, 'E_CODEBASE_CREATE', '创建代码库失败')
      }
    })

    app.post('/:id/complete', async (c) => {
      const id = c.req.param('id')
      if (!uuidOk(id)) return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      try {
        const codebase = await archive.complete(id)
        return c.json({ codebase: withoutManifest(codebase) }, 200)
      } catch (err) {
        return mapError(c, err, 'E_CODEBASE_COMPLETE', '完成代码库上传失败')
      }
    })

    return app
  }
}

function mapReadError(c: Context, Err: unknown, Fallback: string, Message: string) {
  if (Err instanceof CodebaseReadError) {
    const status: 400 | 404 | 409 | 413 | 422 | 500 = Err.code === 'E_NOT_FOUND' || Err.code === 'E_ENTRY_NOT_FOUND' || Err.code === 'E_NO_ORIGINAL'
      ? 404
      : Err.code === 'E_NOT_READY'
        ? 409
        : Err.code === 'E_IS_DIRECTORY'
          ? 400
          : Err.code === 'E_FILE_TOO_LARGE'
            ? 413
            : Err.code === 'E_PRESIGN_FAILED' || Err.code === 'E_ENTRY_DRIFT'
              ? 500
              : 422
    return c.json({ code: Err.code, message: Err.message, ...(Err.codebase ? { codebase: withoutManifest(Err.codebase) } : {}) }, status)
  }
  logError(Fallback, String(Err))
  return c.json({ code: Fallback, message: Message }, 500)
}

function mapDeleteError(c: Context, Err: unknown) {
  if (Err instanceof CodebaseDeleteError) {
    const status: 404 | 409 | 500 = Err.code === 'E_NOT_FOUND' ? 404 : Err.code === 'E_PROCESSING' ? 409 : 500
    return c.json({ code: Err.code, message: Err.message, ...(Err.codebase ? { codebase: withoutManifest(Err.codebase) } : {}) }, status)
  }
  logError('E_CODEBASE_DELETE', String(Err))
  return c.json({ code: 'E_CODEBASE_DELETE', message: '删除代码库失败' }, 500)
}

function mapError(c: Context, Err: unknown, Fallback: string, Message: string) {
  if (Err instanceof CodebaseError) {
    const status: 400 | 404 | 409 | 413 | 422 | 500 = Err.code === 'E_NOT_FOUND'
      ? 404
      : Err.code === 'E_NOT_UPLOADING'
        ? 409
        : Err.code === 'E_BAD_FILENAME' || Err.code === 'E_BAD_SIZE' || Err.code === 'E_BAD_BODY' || Err.code === 'E_BAD_JSON'
          ? 400
          : Err.code === 'E_TOO_LARGE'
            ? 413
            : Err.code === 'E_PRESIGN_FAILED'
              ? 500
              : Err.code.startsWith('E_UPLOAD_') || Err.code.startsWith('E_ZIP_') || Err.code === 'E_BAD_ORIGINAL' || Err.code === 'E_DOWNLOAD_FAILED'
                ? 422
                : 500
    return c.json({ code: Err.code, message: Err.message, ...(Err.codebase ? { codebase: Err.codebase } : {}) }, status)
  }
  logError(Fallback, String(Err))
  return c.json({ code: Fallback, message: Message }, 500)
}

function withoutManifest(Codebase: Codebase): Omit<Codebase, 'manifest'> {
  const { manifest, ...Rest } = Codebase
  void manifest
  return Rest
}

function uuidOk(Id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(Id)
}
