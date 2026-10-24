/**
 * 资源写/分块/计数路由 —— GET /stats 各状态计数、GET /:id/chunks 分页+内容搜索、POST / 入库（url 与 content 二选一）、
 * DELETE /:id 软删（处理中的先按下取消再删）、POST /:id/abort 只取消不删。
 * list/read 由 routes/crud.ts 统一注册到 hono-crud；本文件只保留用例型写路径、分块读取与计数。
 * GET /stats 依赖挂载顺序：本路由必须先于 CRUD 挂载，否则 /resources/:id 会把 stats 当成 id。
 * POST 只负责校验 body + 装配 Recipe/KBData，真正入库交 Factory.assemble(recipe).run(data)。
 * 取消开关由管线自己持有并按 resourceId 登记在 Deps.inflight，本路由只是按按钮的人之一；
 * 客户端断连**不再**是取消来源（run 不接 c.req.raw.signal），批量提交后关页面不影响入库。
 * fetcher/parser 由来源在此定死（url→http/html，content→passthrough/text）；chunker 可由 body 覆盖，缺省 'legacy'（注册表里的策略名）。
 * embed 不再走 body：它是装配层选定的 Deps.embedding（一行 model 句柄 + 标识 + 截维），随 Recipe 原样带进管线，写进 embeddings.model 的就是它的 modelId。
 * 失败映射：查重命中→409；建行后 failed→422（带 resource，failure.code 可为 E_CANCELLED / E_TIMEOUT / E_RESOURCE_GONE / E_INGEST_FAILED）；
 * 装配名不识别(E_UNKNOWN_STAGE)→400；id 非 UUID→400 E_BAD_ID；资源不存在或已软删→404 E_NOT_FOUND；读取分块失败→500 E_CHUNKS；
 * 无可取消任务→409 E_NOT_PROCESSING（状态不是 processing）/ 409 E_NOT_INFLIGHT（是 processing 但不在本进程登记里，重启遗留）；未预期→500。
 * 成功：201 入库（可能带 warning，只是提示、不影响 ready 状态）；202 abort 已按下（异步生效）；204 软删；200 分块。
 */

import 'reflect-metadata'
import { Hono } from 'hono'
import { inject, injectable } from 'tsyringe'
import { IngestError, IngestFactory } from '../ingest/ingest'
import { InflightRegistry } from '../ingest/inflight'
import { PostgresRepo, EmbeddingHandle } from '../adapter/contract'
import { createDbStageSink } from '../trace/systemtrace/stage-sink'
import { currentTraceId, logError } from '../trace/systemtrace/log'

export { ResourcesRoute }

import type { Repo } from '../adapter/contract'
import type { Recipe, KBData } from '../ingest/contracts'

@injectable()
class ResourcesRoute {
  private readonly factory: IngestFactory
  private readonly inflight: InflightRegistry
  private readonly repo: Repo
  private readonly embedding: EmbeddingHandle

  constructor(
    @inject(IngestFactory) Factory: IngestFactory,
    @inject(InflightRegistry) Inflight: InflightRegistry,
    @inject(PostgresRepo) Repo: Repo,
    @inject(EmbeddingHandle) Embedding: EmbeddingHandle,
  ) {
    this.factory = Factory
    this.inflight = Inflight
    this.repo = Repo
    this.embedding = Embedding
  }

  build(): Hono {
    const app = new Hono()
    const repo = this.repo
    const embedding = this.embedding

    app.get('/stats', async (c) => {
      try {
        return c.json({ counts: await repo.resourceCounts() })
      } catch (err) {
        logError('E_RESOURCE_STATS', String(err))
        return c.json({ code: 'E_RESOURCE_STATS', message: '读取资源计数失败' }, 500)
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
          if (!this.inflight.abort(id)) await repo.updateResourceStatus(id, 'failed', '入库中断')
        }
        return (await repo.softDeleteResource(id)) ? c.body(null, 204) : c.json({ code: 'E_NOT_FOUND', message: '资源不存在或已删除' }, 404)
      } catch (err) {
        logError('E_DELETE', String(err))
        return c.json({ code: 'E_DELETE', message: '删除失败' }, 500)
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
        return c.json({ message: '取消已按下，任务不会转为已就绪，将在当前长操作结束后转 failed', resource_id: id }, 202)
      } catch (err) {
        logError('E_ABORT', String(err))
        return c.json({ code: 'E_ABORT', message: '取消失败' }, 500)
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
      const b = body as { url?: unknown; content?: unknown; content_type?: unknown; title?: unknown; chunker?: unknown }

      const url = typeof b.url === 'string' && b.url.trim() !== '' ? b.url.trim() : undefined
      const givenContent = typeof b.content === 'string' ? b.content : undefined
      const content = givenContent !== undefined && givenContent.trim() !== '' ? givenContent : undefined
      if (url === undefined && content === undefined) {
        return c.json(
          { code: givenContent !== undefined ? 'E_EMPTY_CONTENT' : 'E_AMBIGUOUS_INPUT', message: givenContent !== undefined ? '内容不能为空' : 'url 与 content 必须恰好给一个' },
          400,
        )
      }
      if (url !== undefined && content !== undefined) {
        return c.json({ code: 'E_AMBIGUOUS_INPUT', message: 'url 与 content 必须恰好给一个' }, 400)
      }

      const chunker = typeof b.chunker === 'string' && b.chunker.trim() !== '' ? b.chunker.trim() : 'legacy'
      const title = typeof b.title === 'string' && b.title.trim() !== '' ? b.title.trim() : undefined

      let recipe: Recipe
      let data: KBData
      if (url !== undefined) {
        let protocol: string
        try {
          protocol = new URL(url).protocol
        } catch {
          return c.json({ code: 'E_BAD_URL', message: 'url 不合法' }, 400)
        }
        if (protocol !== 'http:' && protocol !== 'https:') {
          return c.json({ code: 'E_BAD_URL', message: '仅支持 http/https' }, 400)
        }
        recipe = { fetcher: 'http', parser: 'html', chunker, embedding, repo }
        data = { content_type: 'url', url, ...(title ? { title } : {}) }
      } else {
        const ct = b.content_type
        if (ct !== 'markdown' && ct !== 'plaintext') {
          return c.json({ code: 'E_BAD_CONTENT_TYPE', message: 'content_type 只能是 markdown 或 plaintext' }, 400)
        }
        recipe = { fetcher: 'passthrough', parser: 'text', chunker, embedding, repo }
        data = { content_type: ct, content: content!, ...(title ? { title } : {}) }
      }

      try {
        const TraceId = currentTraceId()
        const result = await this.factory.assemble(recipe).run(data, undefined, { sink: createDbStageSink(this.repo) })
        if (TraceId !== undefined && result.resource !== null) {
          try {
            await this.repo.setTraceResource(TraceId, result.resource.id)
          } catch (err) {
            logError('E_TRACE_WRITE', `回填 trace resource_id 失败: ${String(err)}`)
          }
        }
        if (result.failure?.code === 'E_DUPLICATE') {
          return c.json({ code: 'E_DUPLICATE', message: result.failure.reason }, 409)
        }
        if (result.resource && result.resource.status === 'failed') {
          return c.json({ code: result.failure?.code ?? 'E_INGEST_FAILED', message: result.failure?.reason ?? '入库失败', resource: result.resource }, 422)
        }
        return c.json({ resource: result.resource, chunk_count: result.chunkCount, ...(result.warning ? { warning: result.warning } : {}) }, 201)
      } catch (err) {
        if (err instanceof IngestError) return c.json({ code: err.code, message: err.message }, 400)
        logError('E_INGEST', String(err))
        return c.json({ code: 'E_INGEST', message: '入库失败' }, 500)
      }
    })

    return app
  }
}

function uuidOk(Id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(Id)
}
