import { Hono } from 'hono'

export { createResourcesRoute }

import type { IngestDeps } from '../orchestration/ingest'

function createResourcesRoute(Deps: IngestDeps): Hono {
  const app = new Hono()

  app.get('/', async (c) => {
    try {
      const resources = await Deps.repo.listResources()
      return c.json({ resources })
    } catch (err) {
      console.error(JSON.stringify({ code: 'E_LIST', message: String(err) }))
      return c.json({ code: 'E_LIST', message: '读取资源列表失败' }, 500)
    }
  })

  app.get('/:id/chunks', async (c) => {
    const id = c.req.param('id')
    try {
      const chunks = await Deps.repo.getChunksByResource(id)
      return c.json({ chunks })
    } catch (err) {
      console.error(JSON.stringify({ code: 'E_CHUNKS', message: String(err) }))
      return c.json({ code: 'E_CHUNKS', message: '读取分块失败' }, 500)
    }
  })

  return app
}
