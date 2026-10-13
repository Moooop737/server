/**
 * 资源路由 —— GET / 列表、GET /:id/chunks 分块、POST / 入库（url 与 content 二选一）。
 * POST 只负责校验 body + 装配 Recipe/KBData，真正入库交 Factory.assemble(recipe).run(data, signal)。
 * fetcher/parser 由来源在此定死（url→http/html，content→passthrough/text）；chunker/embedder 可由 body 覆盖，
 * 缺省值是注册表里的**策略名**（'legacy' / 'qwenembed'）——与 PipelineConfig.embeddingModel（写进 embeddings.model 的模型标识）分属两套名字，别混用。
 * 失败映射：查重命中→409；建行后 failed→422（带 resource）；装配名不识别(E_UNKNOWN_STAGE)→400；未预期→500。
 * 成功 201 可能带 warning（如「可能抓不全」），只是提示、不影响 ready 状态。
 */

import { Hono } from 'hono'
import { IngestError } from '../../pipeline/pipelines'

export { createResourcesRoute }

import type { Repository } from '../../ports/repository'
import type { PipelineFactory } from '../../pipeline/pipelines'
import type { Recipe, KBData, PipelineConfig } from '../../pipeline/contracts'

interface ResourcesRouteDeps {
  repo: Repository
  factory: PipelineFactory
  pipelineConfig: PipelineConfig
}

function createResourcesRoute(Deps: ResourcesRouteDeps): Hono {
  const app = new Hono()
  const { repo, factory, pipelineConfig } = Deps

  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
    }
    try {
      const current = await repo.getResource(id)
      if (!current) return c.json({ code: 'E_NOT_FOUND', message: '资源不存在或已删除' }, 404)
      if (current.status === 'processing') {
        return c.json({ code: 'E_DELETE_PROCESSING', message: '资源处理中，等入库结束后再删' }, 409)
      }
      return (await repo.softDeleteResource(id)) ? c.body(null, 204) : c.json({ code: 'E_NOT_FOUND', message: '资源不存在或已删除' }, 404)
    } catch (err) {
      console.error(JSON.stringify({ code: 'E_DELETE', message: String(err) }))
      return c.json({ code: 'E_DELETE', message: '删除失败' }, 500)
    }
  })

  app.get('/', async (c) => {
    try {
      const resources = await repo.listResources()
      return c.json({ resources })
    } catch (err) {
      console.error(JSON.stringify({ code: 'E_LIST', message: String(err) }))
      return c.json({ code: 'E_LIST', message: '读取资源列表失败' }, 500)
    }
  })

  app.get('/:id/chunks', async (c) => {
    const id = c.req.param('id')
    try {
      const chunks = await repo.getChunksByResource(id)
      return c.json({ chunks })
    } catch (err) {
      console.error(JSON.stringify({ code: 'E_CHUNKS', message: String(err) }))
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
    const b = body as { url?: unknown; content?: unknown; content_type?: unknown; title?: unknown; chunker?: unknown; embedder?: unknown }

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
    const embedder = typeof b.embedder === 'string' && b.embedder.trim() !== '' ? b.embedder.trim() : 'qwenembed'
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
      recipe = { fetcher: 'http', parser: 'html', chunker, embedder, repo, config: pipelineConfig }
      data = { content_type: 'url', url, ...(title ? { title } : {}) }
    } else {
      const ct = b.content_type
      if (ct !== 'markdown' && ct !== 'plaintext') {
        return c.json({ code: 'E_BAD_CONTENT_TYPE', message: 'content_type 只能是 markdown 或 plaintext' }, 400)
      }
      recipe = { fetcher: 'passthrough', parser: 'text', chunker, embedder, repo, config: pipelineConfig }
      data = { content_type: ct, content: content!, ...(title ? { title } : {}) }
    }

    try {
      const result = await factory.assemble(recipe).run(data, c.req.raw.signal)
      if (result.failure?.code === 'E_DUPLICATE') {
        return c.json({ code: 'E_DUPLICATE', message: result.failure.reason }, 409)
      }
      if (result.resource && result.resource.status === 'failed') {
        return c.json({ code: result.failure?.code ?? 'E_INGEST_FAILED', message: result.failure?.reason ?? '入库失败', resource: result.resource }, 422)
      }
      return c.json({ resource: result.resource, chunk_count: result.chunkCount, ...(result.warning ? { warning: result.warning } : {}) }, 201)
    } catch (err) {
      if (err instanceof IngestError) return c.json({ code: err.code, message: err.message }, 400)
      console.error(JSON.stringify({ code: 'E_INGEST', message: String(err) }))
      return c.json({ code: 'E_INGEST', message: '入库失败' }, 500)
    }
  })

  return app
}
