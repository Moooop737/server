/**
 * 入口 / 装配 —— 先 resolve AppConfig（env 装载与校验）与三条路由（顺带触发 EmbeddingTarget / ChatHandle 两个名字位校验），再 await 启动清扫，最后才 serve()。
 * 本文件只做装配、不含业务判定：探针定义见 health/probes.ts，端点逻辑见 routes/ 各文件。
 * 加服务 = 往 createHealthProbes 加一项；加路由 = 路由文件里写 @injectable() 的 class，在此 container.resolve(X).build()。
 * 三条路由的依赖全部由 tsyringe 交（各类自己的 @singleton() 在模块被 import 时注册），本文件不再往下传袋子。
 * 末尾那段顺序是约束不是风格：cleanUpOnBoot 会删 chunks（AD-7），必须 await 完再 serve；本项目是 type:commonjs，顶层写不了 await，故包了一层 IIFE。
 */

import 'reflect-metadata'
import { container } from 'tsyringe'
import { createHealthProbes } from './routes/health/probes'
import { createHealthRoute } from './routes/health/health'
import { ResourcesRoute } from './routes/resources/resources'
import { RetrieveRoute } from './routes/retrieve/retrieve'
import { ChatRoute } from './routes/chat/chat'
import { PostgresRepo } from './adapter/contract'
import { AppConfig, cleanUpOnBoot } from './config'
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const app = new Hono()

const repo = container.resolve(PostgresRepo)
const config = container.resolve(AppConfig)

app.route('/', createHealthRoute(createHealthProbes(config, repo)))
app.route('/resources', container.resolve(ResourcesRoute).build())
app.route('/retrieve', container.resolve(RetrieveRoute).build())
app.route('/chat', container.resolve(ChatRoute).build())

void (async () => {
    await cleanUpOnBoot(repo, config)
    serve({
        fetch: app.fetch,
        hostname: config.host,
        port: config.port,
    })
    console.log('Server listening on http://' + config.host + ':' + config.port)
})()
