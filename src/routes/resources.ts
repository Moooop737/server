import { Hono } from 'hono'
import { IngestError, runIngest, type IngestDeps } from '../orchestration/ingest'
import type { IngestInput } from '../pipeline/contracts'

// 挂在后端根路径（前端经 vite 代理 /api/* → /*）
export function createResourcesRoute(deps: IngestDeps): Hono {
  const app = new Hono()

  // 上传 Markdown/纯文本入库（Story 1.3）
  app.post('/resources', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ code: 'E_BAD_JSON', message: '请求体不是合法 JSON' }, 400)
    }

    const b = body as { content_type?: unknown; content?: unknown; title?: unknown }
    const contentType = b.content_type
    if (contentType !== 'markdown' && contentType !== 'plaintext') {
      return c.json({ code: 'E_BAD_CONTENT_TYPE', message: 'content_type 只能是 markdown 或 plaintext' }, 400)
    }
    if (typeof b.content !== 'string' || b.content.trim() === '') {
      return c.json({ code: 'E_EMPTY_CONTENT', message: '内容不能为空' }, 400)
    }

    const input: IngestInput = { kind: 'text', content_type: contentType, content: b.content }
    if (typeof b.title === 'string' && b.title.trim() !== '') input.title = b.title.trim()

    try {
      const result = await runIngest(deps, input)
      return c.json({ resource: result.resource, chunk_count: result.chunkCount }, 201)
    } catch (err) {
      if (err instanceof IngestError) {
        return c.json({ code: err.code, message: err.message }, 400)
      }
      console.error(JSON.stringify({ code: 'E_INGEST', message: String(err) }))
      return c.json({ code: 'E_INGEST', message: '入库失败' }, 500)
    }
  })

  // 知识库资源列表（只读，供前端展示；软删/取消属 Story 1.4）
  app.get('/resources', async (c) => {
    try {
      const resources = await deps.repo.listResources()
      return c.json({ resources })
    } catch (err) {
      console.error(JSON.stringify({ code: 'E_LIST', message: String(err) }))
      return c.json({ code: 'E_LIST', message: '读取资源列表失败' }, 500)
    }
  })

  // 某资源的分块明细（前端展开查看每块内容）
  app.get('/resources/:id/chunks', async (c) => {
    const id = c.req.param('id')
    try {
      const chunks = await deps.repo.getChunksByResource(id)
      return c.json({ chunks })
    } catch (err) {
      console.error(JSON.stringify({ code: 'E_CHUNKS', message: String(err) }))
      return c.json({ code: 'E_CHUNKS', message: '读取分块失败' }, 500)
    }
  })

  return app
}
