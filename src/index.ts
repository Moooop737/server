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
import { ModelsRoute } from './routes/models'
import { ConfigRoute } from './routes/config'
import { ConfigRetrievalRoute } from './routes/config-retrieval'
import { EvalRoute } from './routes/eval'
import { EvalAssembly } from './eval/assembly'
import { SessionsRoute } from './routes/sessions'
import { ObservabilityRoute } from './routes/observability'
import { TracesRoute } from './routes/traces'
import { createCrudRoot, registerAllCrud } from './routes/crud'
import { createDocRoute } from './routes/doc'
import { ObjectStoreHandle, PostgresCodebaseRepo, PostgresRepo, RuntimeRetrievalRegistry } from './adapter/contract'
import { RuntimeModelRegistry } from './adapter/model/runtime-registry'
import { AppConfig, cleanUpOnBoot } from './config'
import { serve } from '@hono/node-server'
import { createEndpointTrace } from './trace/systemtrace/endpoint'
import { logInfo, logWarn, logError } from './trace/systemtrace/log'
import { setupLangfuse } from './trace/llmtrace/langfuse'

setupLangfuse()

function errorCodeOf(Err: unknown): string | null {
  let Current: unknown = Err
  while (Current !== null && typeof Current === 'object') {
    const Code = (Current as { code?: unknown }).code
    if (typeof Code === 'string') return Code
    Current = (Current as { cause?: unknown }).cause
  }
  return null
}

void (async () => {
  const repo = container.resolve(PostgresRepo)
  const config = container.resolve(AppConfig)
  const store = container.resolve(ObjectStoreHandle)
  const Runtime = container.resolve(RuntimeModelRegistry)
  const Retrieval = container.resolve(RuntimeRetrievalRegistry)

  try {
    await Runtime.load()
    logInfo('I_CONFIG_LOADED', '运行时配置已装载')
  } catch (err) {
    const Code = errorCodeOf(err) ?? 'E_CONFIG_LOAD'
    logError(Code, err instanceof Error ? (err.stack ?? err.message) : String(err))
    process.exit(1)
  }

  try {
    const Snap = await Retrieval.load()
    logInfo('I_RETRIEVAL_LOADED', `检索管线已装载 generation=${Snap.generation} version=${Snap.version} nodes=${Snap.pipeline.nodes.length}`)
  } catch (err) {
    const Code = errorCodeOf(err) ?? 'E_RETRIEVAL_CONFIG_LOAD'
    logError(Code, err instanceof Error ? (err.stack ?? err.message) : String(err))
    process.exit(1)
  }

  const { app, router } = await createCrudRoot();

  try {
    // 先挂 /eval 再挂主壳：Hono 的 use('*') 只作用于其后注册的路由，评测请求不落主库 trace
    const Eval = container.resolve(EvalAssembly)
    app.route('/eval', container.resolve(EvalRoute).build())
    logInfo('I_EVAL_MODE', Eval.mode === 'shared' ? '共享模式：评测跑在主库' : '隔离模式：评测跑在独立库')

    app.use('*', async (c: any, next: any) => { c.set('db', repo.orm); await next() })
    app.use('*', createEndpointTrace(repo))

    app.route('/resources', container.resolve(ResourcesRoute).build())
    app.route('/codebases', container.resolve(CodebasesRoute).build())
    app.route('/traces', container.resolve(TracesRoute).build())
    app.route('/sessions', container.resolve(SessionsRoute).build())
    app.route('/observability', container.resolve(ObservabilityRoute).build())
    app.route('/health', createHealthRoute(createHealthServices(Runtime, repo, store, { mode: Eval.mode, ping: () => Eval.repo.ping() })))
    app.route('/retrieve', container.resolve(RetrieveRoute).build())
    app.route('/chat', container.resolve(ChatRoute).build())
    app.route('/models', container.resolve(ModelsRoute).build())
    app.route('/config', container.resolve(ConfigRoute).build())
    app.route('/config/retrieval', container.resolve(ConfigRetrievalRoute).build())
    await registerAllCrud(app)
    app.route('/doc', createDocRoute(router, `http://${config.host}:${config.port}`))

  } catch (err) {
    logError('E_ASSEMBLY', err instanceof Error ? (err.stack ?? err.message) : JSON.stringify(err))
    process.exit(1)
  }

  await cleanUpOnBoot(repo, container.resolve(PostgresCodebaseRepo), Runtime.embeddingDefault()?.dimensions ?? null)
  try {
    const Cleaned = await container.resolve(EvalAssembly).repo.markInterruptedRuns()
    if (Cleaned > 0) logInfo('I_EVAL_RUN_CLEANUP', `中断的评测运行已标 cancelled：${Cleaned}`)
  } catch (err) {
    logWarn('W_EVAL_RUN_CLEANUP', `评测运行清扫失败，服务继续启动：${String(err)}`)
  }
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


