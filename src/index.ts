/**
 * 入口 / 装配 —— bootstrap() 交出 app + deps，在此组装健康探针、挂各业务路由，全部装配完再 startServer 监听。
 * 本文件只做装配、不含业务判定：探针定义见 health/probes.ts，端点逻辑见 routes/ 各文件。
 * 加服务 = 往 createHealthProbes 加一项；加路由 = 在此再 app.route(...)。URL 入库端点待 Story 1.2 接线后追加。
 */

import { bootstrap, startServer } from './bootstrap'
import { createHealthProbes } from './routes/health/probes'
import { createHealthRoute } from './routes/health/health'
import { createResourcesRoute } from './routes/resources/resources'
import { createResourcesTextRoute } from './routes/resources/resources-text'

const { app, deps } = bootstrap()

app.route('/', createHealthRoute(createHealthProbes(deps.config, deps.pool)))
app.route('/resources', createResourcesRoute(deps.ingestDeps))
app.route('/resources', createResourcesTextRoute(deps.ingestDeps))

void startServer(app, deps)
