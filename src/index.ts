/**
 * 入口 / 装配 —— 四张表的 CRUD 由 routes/crud.ts 一处注册（hono-crud 的 ESM 细节关在那里）；
 * 自定义用例路由（resources 写入/分块、sessions messages、retrieve/chat、health）都是 plain Hono，按需挂载；
 * Scalar 文档页由 routes/doc.ts 提供：四表 CRUD 自动生成 + 自定义端点手写 OpenAPI。
 * 末尾 cleanUpOnBoot 必须先 await 再 serve；本项目是 type:commonjs，顶层写不了 await，故包一层 IIFE。
 */

import 'reflect-metadata'
import { container } from 'tsyringe'
import { createHealthProbes, createHealthRoute } from './routes/health'
import { ResourcesRoute } from './routes/resources'
import { RetrieveRoute } from './routes/retrieve'
import { ChatRoute } from './routes/chat'
import { SessionsRoute } from './routes/sessions'
import { createCrudRoot, registerAllCrud } from './routes/crud'
import { createDocRoute } from './routes/doc'
import { PostgresRepo } from './adapter/contract'
import { AppConfig, cleanUpOnBoot } from './config'
import { serve } from '@hono/node-server'
import { createEndpointTrace } from './trace/systemtrace/endpoint'
import { logInfo, logError } from './trace/systemtrace/log'

void (async () => {
  const repo = container.resolve(PostgresRepo)
  const config = container.resolve(AppConfig)
  const { app, router } = await createCrudRoot();

  try {
    app.use('*', async (c: any, next: any) => { c.set('db', repo.orm); await next() })
    app.use('*', createEndpointTrace(repo))

    await registerAllCrud(app)
    app.route('/resources', container.resolve(ResourcesRoute).build())
    app.route('/sessions', container.resolve(SessionsRoute).build())
    app.route('/health', createHealthRoute(createHealthProbes(config, repo)))
    app.route('/retrieve', container.resolve(RetrieveRoute).build())
    app.route('/chat', container.resolve(ChatRoute).build())
    app.route('/doc', createDocRoute(router, `http://${config.host}:${config.port}`))

  } catch (err) {
    logError('E_ASSEMBLY', err instanceof Error ? (err.stack ?? err.message) : JSON.stringify(err))
    process.exit(1)
  }

  await cleanUpOnBoot(repo, config)
  serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  })
  logInfo('I_SERVER_READY', 'Server listening on http://' + config.host + ':' + config.port)
})()


