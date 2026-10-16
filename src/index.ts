/**
 * 入口 / 装配 —— bootstrap() 交出 app + deps，在此组装健康探针、挂业务路由，全部装配完再 startServer 监听。
 * 本文件只做装配、不含业务判定：探针定义见 health/probes.ts，端点逻辑见 routes/ 各文件。
 * 加服务 = 往 createHealthProbes 加一项；加路由 = 在此再 app.route(...)。
 */

import { bootstrap, startServer } from './bootstrap'
import { createHealthProbes } from './routes/health/probes'
import { createHealthRoute } from './routes/health/health'
import { createResourcesRoute } from './routes/resources/resources'
import { createRetrieveRoute } from './routes/retrieve/retrieve'
import { createChatRoute } from './routes/chat/chat'

const { app, deps } = bootstrap()

app.route('/', createHealthRoute(createHealthProbes(deps.config, deps.repo)))
app.route('/resources', createResourcesRoute(deps))
app.route('/retrieve', createRetrieveRoute(deps))
app.route('/chat', createChatRoute(deps))

void startServer(app, deps)
