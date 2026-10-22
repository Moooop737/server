/**
 * 入口 / 装配 —— 先 resolve AppConfig（env 装载与校验）与四条路由（顺带触发 EmbeddingHandle / ChatHandle 两个名字位校验），再 await 启动清扫，最后才 serve()。
 * 本文件只做装配、不含业务判定：探针定义见 health/probes.ts，端点逻辑见 routes/ 各文件。
 * 加服务 = 往 createHealthProbes 加一项；加路由 = 路由文件里写 @injectable() 的 class，在此 container.resolve(X).build()。
 * 三条路由的依赖全部由 tsyringe 交（各类自己的 @singleton() 在模块被 import 时注册），本文件不再往下传袋子。
 * 路由 resolve 会顺带构造 RetrieverHandle 并 assemble；策略名漂移在这里失败，按 E_ASSEMBLY 打一行 JSON 后 exit(1)，不裸栈。
 * 末尾那段顺序是约束不是风格：cleanUpOnBoot 会删 chunks（AD-7），必须 await 完再 serve；本项目是 type:commonjs，顶层写不了 await，故包了一层 IIFE。
 */

import 'reflect-metadata'
import { container } from 'tsyringe'
import { createHealthProbes } from './routes/health/probes'
import { createHealthRoute } from './routes/health/health'
import { ResourcesRoute } from './routes/resources/resources'
import { RetrieveRoute } from './routes/retrieve/retrieve'
import { ChatRoute } from './routes/chat/chat'
import { SessionsRoute } from './routes/sessions/sessions'
import { PostgresRepo } from './adapter/contract'
import { AppConfig, cleanUpOnBoot } from './config'
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Scalar } from '@scalar/hono-api-reference';
import { parse } from 'yaml';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createEndpointTrace } from './trace/systemtrace/endpoint';
import { logInfo, logError } from './trace/systemtrace/log';
import { TraceRoute } from './routes/trace/trace';

void (async () => {
    const app = new Hono()
    const repo = container.resolve(PostgresRepo)
    const config = container.resolve(AppConfig)
    const openapi = parse(await readFile(join(__dirname, 'routes/doc/open-api.yml'), 'utf-8'))

    try {
        app.use('*', createEndpointTrace(repo))
        app.route('/health', createHealthRoute(createHealthProbes(config, repo)))
        app.route('/resources', container.resolve(ResourcesRoute).build())
        app.route('/retrieve', container.resolve(RetrieveRoute).build())
        app.route('/chat', container.resolve(ChatRoute).build())
        app.route('/sessions', container.resolve(SessionsRoute).build())
        app.route('/traces', container.resolve(TraceRoute).build())
        app.route('/doc', Scalar.serve({ document: openapi, defaultOpenAllTags: true, theme: 'kepler'}))
    } catch (err) {
        logError('E_ASSEMBLY', String(err))
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
