import 'reflect-metadata'
import { bootstrap, startServer } from './bootstrap'
import { container } from 'tsyringe'
import { createHealthProbes } from './routes/health/probes'
import { createHealthRoute } from './routes/health/health'
import { ResourcesRoute } from './routes/resources/resources'
import { RetrieveRoute } from './routes/retrieve/retrieve'
import { ChatRoute } from './routes/chat/chat'

const { app, deps } = bootstrap()

app.route('/', createHealthRoute(createHealthProbes(deps.config, deps.repo)))
app.route('/resources', container.resolve(ResourcesRoute).build(deps))
app.route('/retrieve', container.resolve(RetrieveRoute).build(deps))
app.route('/chat', container.resolve(ChatRoute).build(deps))

void startServer(app, deps)