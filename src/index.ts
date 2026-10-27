/**
 * 入口 / 装配 —— 四张表的 CRUD 由 routes/crud.ts 一处注册（hono-crud 的 ESM 细节关在那里）；
 * 自定义用例路由（resources 写入/分块/计数、sessions messages、retrieve/chat、health）都是 plain Hono，按需挂载；
 * Scalar 文档页由 routes/doc.ts 提供：四表 CRUD 自动生成 + 自定义端点手写 OpenAPI。
 * 末尾 cleanUpOnBoot 必须先 await 再 serve；本项目是 type:commonjs，顶层写不了 await，故包一层 IIFE。
 */

import 'reflect-metadata'
import { container } from 'tsyringe'
import { createHealthServices, createHealthRoute } from './routes/health'
import { ResourcesRoute } from './routes/resources'
import { CodebasesRoute } from './routes/codebases'
import { RetrieveRoute } from './routes/retrieve'
import { ChatRoute } from './routes/chat'
import { SessionsRoute } from './routes/sessions'
import { ObservabilityRoute } from './routes/observability'
import { TracesRoute } from './routes/traces'
import { createCrudRoot, registerAllCrud } from './routes/crud'
import { createDocRoute } from './routes/doc'
import { ObjectStoreHandle, PostgresCodebaseRepo, PostgresRepo } from './adapter/contract'
import { AppConfig, cleanUpOnBoot } from './config'
import { serve } from '@hono/node-server'
import { createEndpointTrace } from './trace/systemtrace/endpoint'
import { logInfo, logWarn, logError } from './trace/systemtrace/log'
import { setupLangfuse } from './trace/llmtrace/langfuse'

setupLangfuse()

void (async () => {
  const repo = container.resolve(PostgresRepo)
  const config = container.resolve(AppConfig)
  const store = container.resolve(ObjectStoreHandle)
  const { app, router } = await createCrudRoot();

  try {
    app.use('*', async (c: any, next: any) => { c.set('db', repo.orm); await next() })
    app.use('*', createEndpointTrace(repo))

    app.route('/resources', container.resolve(ResourcesRoute).build())
    app.route('/codebases', container.resolve(CodebasesRoute).build())
    app.route('/traces', container.resolve(TracesRoute).build())
    app.route('/sessions', container.resolve(SessionsRoute).build())
    app.route('/observability', container.resolve(ObservabilityRoute).build())
    app.route('/health', createHealthRoute(createHealthServices(config, repo, store)))
    app.route('/retrieve', container.resolve(RetrieveRoute).build())
    app.route('/chat', container.resolve(ChatRoute).build())
    await registerAllCrud(app)
    app.route('/doc', createDocRoute(router, `http://${config.host}:${config.port}`))

  } catch (err) {
    logError('E_ASSEMBLY', err instanceof Error ? (err.stack ?? err.message) : JSON.stringify(err))
    process.exit(1)
  }

  await cleanUpOnBoot(repo, container.resolve(PostgresCodebaseRepo), config)
  try {
    await store.ensureBucket()
    logInfo('I_OBJECT_STORE', `对象存储就绪：${config.s3Bucket}`)
  } catch (err) {
    logWarn('W_OBJECT_STORE', `对象存储检查失败，服务继续启动：${String(err)}`)
  }
  serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  })
  logInfo('I_SERVER_READY', 'Server listening on http://' + config.host + ':' + config.port)
})()


