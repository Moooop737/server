import { Hono } from 'hono'
import { IngestError, runIngest } from '../orchestration/ingest'

export { createResourcesTextRoute }

import type { IngestDeps } from '../orchestration/ingest'
import type { IngestInput } from '../pipeline/contracts'

function createResourcesTextRoute(Deps: IngestDeps): Hono {
  const app = new Hono()

  app.post('/text', async (c) => {
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
      const result = await runIngest(Deps, input)
      return c.json({ resource: result.resource, chunk_count: result.chunkCount }, 201)
    } catch (err) {
      if (err instanceof IngestError) {
        return c.json({ code: err.code, message: err.message }, 400)
      }
      console.error(JSON.stringify({ code: 'E_INGEST', message: String(err) }))
      return c.json({ code: 'E_INGEST', message: '入库失败' }, 500)
    }
  })

  return app
}
