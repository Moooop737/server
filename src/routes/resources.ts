/**
 * 资源路由 —— GET /stats、GET /deleted 回收站、GET /:id/chunks 分页+内容搜索、POST /（文件 presign / URL 归档 / 粘贴归档）、
 * POST /:id/confirm-upload（文件 PUT 后 stat/类型/大小门禁，转 uploaded）、
 * POST /:id/ingest（stat 原始对象后解析/切块/embed）、GET /:id/original（presign GET + 302）、
 * POST /:id/restore（软删恢复）、DELETE /:id 软删、DELETE /:id/purge 彻底删除（只接软删行）、POST /:id/abort 只取消不删。
 * POST / 只归档原始内容；ingest 只处理已归档资源，状态 uploaded → processing → ready/process_failed。
 * list/read 由 routes/crud.ts 统一注册到 hono-crud；GET /stats 必须先于 CRUD 挂载。
 * 取消开关由 ingest 管线持有并按 resourceId 登记在 InflightRegistry；abort/DELETE 只处理 processing 行。
 * 失败映射：URL 重复/状态冲突→409；建行后归档失败/上传门禁失败→422（带 resource）；输入不合法→400；过大→413；未预期→500。
 */

import 'reflect-metadata'
import { Hono } from 'hono'
import { inject, injectable } from 'tsyringe'
import { InflightRegistry } from '../ingest/inflight'
import { IngestError } from '../ingest/ingest'
import { PostgresRepo } from '../adapter/contract'
import { ResourceArchive, ArchiveError } from '../resource/archive'
import { ResourceIngest, IngestGateError } from '../resource/ingest'
import { ResourceDownload, DownloadError } from '../resource/download'
import { ResourceRestore, RestoreError } from '../resource/restore'
import { ResourcePurge, PurgeError } from '../resource/purge'
import { isSha256Hex } from '../adapter/storage/hash'
import { currentTraceId, logError } from '../trace/systemtrace/log'

export { ResourcesRoute }

import type { Repo } from '../adapter/contract'

@injectable()
class ResourcesRoute {
  private readonly inflight: InflightRegistry
  private readonly repo: Repo
  private readonly archive: ResourceArchive
  private readonly ingest: ResourceIngest
  private readonly download: ResourceDownload
  private readonly restore: ResourceRestore
  private readonly purge: ResourcePurge

  constructor(
    @inject(InflightRegistry) Inflight: InflightRegistry,
    @inject(PostgresRepo) Repo: Repo,
    @inject(ResourceArchive) Archive: ResourceArchive,
    @inject(ResourceIngest) Ingest: ResourceIngest,
    @inject(ResourceDownload) Download: ResourceDownload,
    @inject(ResourceRestore) Restore: ResourceRestore,
    @inject(ResourcePurge) Purge: ResourcePurge,
  ) {
    this.inflight = Inflight
    this.repo = Repo
    this.archive = Archive
    this.ingest = Ingest
    this.download = Download
    this.restore = Restore
    this.purge = Purge
  }

  build(): Hono {
    const app = new Hono()
    const repo = this.repo
    const archive = this.archive
    const ingest = this.ingest
    const download = this.download
    const restore = this.restore
    const purge = this.purge

    app.get('/stats', async (c) => {
      try {
        return c.json({ counts: await repo.resourceCounts() })
      } catch (err) {
        logError('E_RESOURCE_STATS', String(err))
        return c.json({ code: 'E_RESOURCE_STATS', message: '读取资源计数失败' }, 500)
      }
    })

    app.get('/deleted', async (c) => {
      const PageRaw = c.req.query('page')
      const PerPageRaw = c.req.query('per_page')
      const Page = PageRaw === undefined ? 1 : Number(PageRaw)
      const PerPage = PerPageRaw === undefined ? 20 : Number(PerPageRaw)
      if (!Number.isInteger(Page) || Page < 1 || Page > 1_000_000 || !Number.isInteger(PerPage) || PerPage < 1 || PerPage > 100) {
        return c.json({ code: 'E_BAD_QUERY', message: 'page 需为 1-1000000 的整数，per_page 需为 1-100 的整数' }, 400)
      }
      const Search = (c.req.query('search') ?? '').trim().slice(0, 200)
      try {
        let First = await repo.listDeletedResources((Page - 1) * PerPage, PerPage, Search)
        const TotalPages = Math.ceil(First.TotalCount / PerPage)
        let ShownPage = Page
        if (First.Items.length === 0 && First.TotalCount > 0 && Page > 1) {
          ShownPage = Math.max(1, TotalPages)
          First = await repo.listDeletedResources((ShownPage - 1) * PerPage, PerPage, Search)
        }
        return c.json({
          resources: First.Items,
          pagination: { page: ShownPage, per_page: PerPage, total_count: First.TotalCount, total_pages: TotalPages },
        })
      } catch (err) {
        logError('E_DELETED_LIST', String(err))
        return c.json({ code: 'E_DELETED_LIST', message: '读取回收站失败' }, 500)
      }
    })

    app.delete('/:id', async (c) => {
      const id = c.req.param('id')
      if (!uuidOk(id)) {
        return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      }
      try {
        const current = await repo.getResource(id)
        if (!current) return c.json({ code: 'E_NOT_FOUND', message: '资源不存在或已删除' }, 404)
        if (current.status === 'processing') {
          // 先掐任务再标删；顺序反了会给已删资源补写一批 chunks。按不下去（重启遗留/异进程）就自己把状态收口，别留一条永远 processing 的行
          if (!this.inflight.abort(id)) await repo.updateResourceStatus(id, 'process_failed', '入库中断')
        }
        return (await repo.softDeleteResource(id)) ? c.body(null, 204) : c.json({ code: 'E_NOT_FOUND', message: '资源不存在或已删除' }, 404)
      } catch (err) {
        logError('E_DELETE', String(err))
        return c.json({ code: 'E_DELETE', message: '删除失败' }, 500)
      }
    })

    app.delete('/:id/purge', async (c) => {
      const id = c.req.param('id')
      if (!uuidOk(id)) {
        return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      }
      try {
        await purge.purge(id)
        await this.setTraceResource(id)
        return c.body(null, 204)
      } catch (err) {
        if (err instanceof PurgeError) {
          if (err.resource) await this.setTraceResource(err.resource.id)
          const status: 404 | 409 | 500 = err.code === 'E_NOT_FOUND' ? 404 : err.code === 'E_NOT_DELETED' ? 409 : 500
          return c.json({ code: err.code, message: err.message }, status)
        }
        logError('E_PURGE', String(err))
        return c.json({ code: 'E_PURGE', message: '彻底删除失败' }, 500)
      }
    })

    app.post('/:id/abort', async (c) => {
      const id = c.req.param('id')
      if (!uuidOk(id)) {
        return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      }
      try {
        const current = await repo.getResource(id)
        if (!current) return c.json({ code: 'E_NOT_FOUND', message: '资源不存在或已删除' }, 404)
        if (current.status !== 'processing') {
          return c.json({ code: 'E_NOT_PROCESSING', message: `资源已是 ${current.status}，没有可取消的任务`, resource_id: id }, 409)
        }
        if (!this.inflight.abort(id)) {
          // 读状态与按下之间任务可能自己跑完；重读一次再说清现在到底是什么状态，别猜成因
          const now = await repo.getResource(id)
          return c.json({ code: 'E_NOT_INFLIGHT', message: '该资源不在本进程的入库登记里', status: now?.status ?? 'gone', resource_id: id }, 409)
        }
        return c.json({ message: '取消已按下，任务不会转为已就绪，将在当前长操作结束后转 process_failed', resource_id: id }, 202)
      } catch (err) {
        logError('E_ABORT', String(err))
        return c.json({ code: 'E_ABORT', message: '取消失败' }, 500)
      }
    })

    app.post('/:id/confirm-upload', async (c) => {
      const id = c.req.param('id')
      if (!uuidOk(id)) {
        return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      }
      try {
        const resource = await ingest.confirmUpload(id)
        await this.setTraceResource(resource.id)
        return c.json({ resource }, 200)
      } catch (err) {
        if (err instanceof IngestGateError) {
          if (err.resource) await this.setTraceResource(err.resource.id)
          const status: 404 | 409 | 422 = err.code === 'E_NOT_FOUND'
            ? 404
            : err.code.startsWith('E_UPLOAD_') || err.code === 'E_UNSUPPORTED_CONTENT_TYPE'
              ? 422
              : 409
          return c.json({ code: err.code, message: err.message, ...(err.resource ? { resource: err.resource } : {}) }, status)
        }
        logError('E_CONFIRM_UPLOAD', String(err))
        return c.json({ code: 'E_CONFIRM_UPLOAD', message: '确认上传失败' }, 500)
      }
    })

    app.post('/:id/ingest', async (c) => {
      const id = c.req.param('id')
      if (!uuidOk(id)) {
        return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      }
      let chunker: string | undefined
      const raw = await c.req.text()
      if (raw.trim() !== '') {
        let body: unknown
        try {
          body = JSON.parse(raw)
        } catch {
          return c.json({ code: 'E_BAD_JSON', message: '请求体不是合法 JSON' }, 400)
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return c.json({ code: 'E_BAD_JSON', message: '请求体需为 JSON 对象' }, 400)
        }
        const ck = (body as { chunker?: unknown }).chunker
        if (ck !== undefined && typeof ck !== 'string') {
          return c.json({ code: 'E_BAD_BODY', message: 'chunker 需为字符串' }, 400)
        }
        chunker = typeof ck === 'string' && ck.trim() !== '' ? ck.trim() : undefined
      }

      try {
        const result = await ingest.ingest(id, chunker)
        if (!result.resource) {
          logError('E_INGEST', '入库返回空 resource')
          return c.json({ code: 'E_INGEST', message: '入库失败' }, 500)
        }
        await this.setTraceResource(result.resource.id)
        if (result.resource.status === 'process_failed') {
          return c.json({ code: result.failure?.code ?? 'E_INGEST_FAILED', message: result.failure?.reason ?? '入库失败', resource: result.resource }, 422)
        }
        return c.json({ resource: result.resource, chunk_count: result.chunkCount, ...(result.warning ? { warning: result.warning } : {}) }, 201)
      } catch (err) {
        if (err instanceof IngestGateError) {
          if (err.resource) await this.setTraceResource(err.resource.id)
          const status: 404 | 409 | 422 = err.code === 'E_NOT_FOUND'
            ? 404
            : err.code.startsWith('E_UPLOAD_') || err.code === 'E_UNSUPPORTED_CONTENT_TYPE'
              ? 422
              : 409
          return c.json({ code: err.code, message: err.message, ...(err.resource ? { resource: err.resource } : {}) }, status)
        }
        if (err instanceof IngestError) return c.json({ code: err.code, message: err.message }, 400)
        logError('E_INGEST', String(err))
        return c.json({ code: 'E_INGEST', message: '入库失败' }, 500)
      }
    })

    app.post('/:id/restore', async (c) => {
      const id = c.req.param('id')
      if (!uuidOk(id)) {
        return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      }
      try {
        const resource = await restore.restore(id)
        await this.setTraceResource(resource.id)
        return c.json({ resource }, 200)
      } catch (err) {
        if (err instanceof RestoreError) {
          if (err.resource) await this.setTraceResource(err.resource.id)
          const status: 404 | 409 = err.code === 'E_NOT_FOUND' ? 404 : 409
          return c.json({ code: err.code, message: err.message, ...(err.resource ? { resource: err.resource } : {}) }, status)
        }
        logError('E_RESTORE', String(err))
        return c.json({ code: 'E_RESTORE', message: '恢复失败' }, 500)
      }
    })

    app.get('/:id/original', async (c) => {
      const id = c.req.param('id')
      if (!uuidOk(id)) {
        return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      }
      try {
        const target = await download.original(id)
        await this.setTraceResource(id)
        return c.body(null, 302, {
          Location: target.url,
          'Cache-Control': 'no-store',
        })
      } catch (err) {
        if (err instanceof DownloadError) {
          if (err.resource) await this.setTraceResource(err.resource.id)
          const status: 404 | 500 = err.code === 'E_NOT_FOUND' || err.code === 'E_NO_ORIGINAL' ? 404 : 500
          return c.json({ code: err.code, message: err.message }, status)
        }
        logError('E_DOWNLOAD', String(err))
        return c.json({ code: 'E_DOWNLOAD', message: '下载失败' }, 500)
      }
    })

    app.get('/:id/chunks', async (c) => {
      const id = c.req.param('id')
      if (!uuidOk(id)) {
        return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      }
      const PageRaw = c.req.query('page')
      const PerPageRaw = c.req.query('per_page')
      const Page = PageRaw === undefined ? 1 : Number(PageRaw)
      const PerPage = PerPageRaw === undefined ? 20 : Number(PerPageRaw)
      if (!Number.isInteger(Page) || Page < 1 || Page > 1_000_000 || !Number.isInteger(PerPage) || PerPage < 1 || PerPage > 100) {
        return c.json({ code: 'E_BAD_QUERY', message: 'page 需为 1-1000000 的整数，per_page 需为 1-100 的整数' }, 400)
      }
      const Search = (c.req.query('search') ?? '').trim().slice(0, 200)
      try {
        if (!(await repo.getResource(id))) {
          return c.json({ code: 'E_NOT_FOUND', message: '资源不存在或已删除' }, 404)
        }
        const First = await repo.getChunksPage(id, (Page - 1) * PerPage, PerPage, Search)
        const TotalPages = Math.ceil(First.TotalCount / PerPage)
        /* 越界页码不原样回显：先收敛到末页再查，否则 curl / Try-it 会拿到自相矛盾的空页 */
        const SafePage = Math.min(Page, Math.max(1, TotalPages))
        const Result = SafePage === Page ? First : await repo.getChunksPage(id, (SafePage - 1) * PerPage, PerPage, Search)
        return c.json({
          chunks: Result.Items,
          pagination: {
            page: SafePage,
            per_page: PerPage,
            total_count: Result.TotalCount,
            total_pages: TotalPages,
          },
        })
      } catch (err) {
        logError('E_CHUNKS', String(err))
        return c.json({ code: 'E_CHUNKS', message: '读取分块失败' }, 500)
      }
    })

    app.post('/', async (c) => {
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ code: 'E_BAD_JSON', message: '请求体不是合法 JSON' }, 400)
      }
      if (body === null || typeof body !== 'object') {
        return c.json({ code: 'E_BAD_JSON', message: '请求体需为 JSON 对象' }, 400)
      }
      const b = body as { url?: unknown; content?: unknown; content_type?: unknown; filename?: unknown; size?: unknown; title?: unknown; content_hash?: unknown }

      const hasUrl = typeof b.url === 'string'
      const hasContent = typeof b.content === 'string'
      const hasFilename = typeof b.filename === 'string'
      if ([hasUrl, hasContent, hasFilename].filter(Boolean).length !== 1) {
        return c.json({ code: 'E_AMBIGUOUS_INPUT', message: 'url、content、filename 必须恰好给一个' }, 400)
      }
      const title = typeof b.title === 'string' && b.title.trim() !== '' ? b.title.trim() : undefined

      try {
        if (hasFilename) {
          const filename = (b.filename as string).trim()
          if (filename === '') return c.json({ code: 'E_BAD_FILENAME', message: '文件名不能为空' }, 400)
          let size: number | undefined
          if (b.size !== undefined) {
            if (typeof b.size !== 'number' || !Number.isInteger(b.size) || b.size < 0) {
              return c.json({ code: 'E_BAD_SIZE', message: 'size 需为非负整数' }, 400)
            }
            size = b.size
          }
          if (typeof b.content_hash !== 'string' || !isSha256Hex(b.content_hash)) {
            return c.json({ code: 'E_BAD_HASH', message: 'content_hash 必须是 64 位小写 SHA-256 hex' }, 400)
          }
          const result = await archive.createFile(filename, size, title, b.content_hash)
          await this.setTraceResource(result.resource.id)
          if (result.upload) return c.json({ resource: result.resource, upload: result.upload }, 201)
          return c.json({ resource: result.resource, ...(result.duplicate ? { duplicate: true } : {}), ...(result.restored ? { restored: true } : {}) }, 200)
        }

        if (hasUrl) {
          const url = (b.url as string).trim()
          if (url === '') return c.json({ code: 'E_BAD_URL', message: 'url 不能为空' }, 400)
          const result = await archive.archiveUrl(url, title)
          await this.setTraceResource(result.resource.id)
          if (result.duplicate || result.restored) {
            return c.json({ resource: result.resource, ...(result.duplicate ? { duplicate: true } : {}), ...(result.restored ? { restored: true } : {}) }, 200)
          }
          return c.json({ resource: result.resource }, 201)
        }

        const content = b.content as string
        const contentType = b.content_type
        if (typeof contentType !== 'string' || contentType.trim() === '') {
          return c.json({ code: 'E_BAD_CONTENT_TYPE', message: '粘贴时必须给 content_type: text/markdown 或 text/plain' }, 400)
        }
        const result = await archive.archiveText(content, contentType.trim(), title)
        await this.setTraceResource(result.resource.id)
        if (result.duplicate || result.restored) {
          return c.json({ resource: result.resource, ...(result.duplicate ? { duplicate: true } : {}), ...(result.restored ? { restored: true } : {}) }, 200)
        }
        return c.json({ resource: result.resource }, 201)
      } catch (err) {
        if (err instanceof ArchiveError) {
          if (err.resource) await this.setTraceResource(err.resource.id)
          const status: 400 | 409 | 413 | 422 | 500 = err.code === 'E_DUPLICATE' || err.code === 'E_ORIGINAL_LOST'
            ? 409
            : err.code === 'E_KEY_ALLOC'
              ? 500
              : err.resource
                ? 422
                : err.code === 'E_TOO_LARGE'
                  ? 413
                  : 400
          return c.json({ code: err.code, message: err.message, ...(err.resource ? { resource: err.resource } : {}) }, status)
        }
        logError('E_ARCHIVE', String(err))
        return c.json({ code: 'E_ARCHIVE', message: '归档失败' }, 500)
      }
    })

    return app
  }

  private async setTraceResource(ResourceId: string): Promise<void> {
    const TraceId = currentTraceId()
    if (TraceId === undefined) return
    try {
      await this.repo.setTraceResource(TraceId, ResourceId)
    } catch (err) {
      logError('E_TRACE_WRITE', `回填 trace resource_id 失败: ${String(err)}`)
    }
  }
}

function uuidOk(Id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(Id)
}
