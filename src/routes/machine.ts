/**
 * /machine —— machine 定义的读取、整机替换、装配预检与同步运行；裸 Hono，不进 hono-crud。
 * PUT 先校验字段、绑定图存在，再跑四类节点的配置契约；配置不全不落库。
 * POST /preflight 走 MachineAssembly：已存图或草稿整图 → plan / 错误；不写库、不调模型。
 * POST /:id/run 走 MachineRunner：编译已存图 → 单 worker 同步跑一次；不写会话历史。
 */

export { MachineRoute }

import 'reflect-metadata'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { inject, injectable } from 'tsyringe'
import { PostgresMachineRepo, PostgresSwarmRepo } from '../adapter/contract'
import { MachineAssembly } from '../swarm/machine/assembly'
import { MachineRunner, MachineRunError } from '../swarm/machine/runner'
import { validateNodeConfigs } from '../swarm/machine/nodes'
import { logError } from '../trace/systemtrace/log'

import type { SwarmEdge, SwarmGraphDef, SwarmNode } from '../swarm/graph'

const NAME_MAX = 80

@injectable()
class MachineRoute {
  private readonly repo: PostgresMachineRepo
  private readonly swarms: PostgresSwarmRepo
  private readonly assembly: MachineAssembly
  private readonly runner: MachineRunner

  constructor(
    @inject(PostgresMachineRepo) Repo: PostgresMachineRepo,
    @inject(PostgresSwarmRepo) Swarms: PostgresSwarmRepo,
    @inject(MachineAssembly) Assembly: MachineAssembly,
    @inject(MachineRunner) Runner: MachineRunner,
  ) {
    this.repo = Repo
    this.swarms = Swarms
    this.assembly = Assembly
    this.runner = Runner
  }

  build(): Hono {
    const app = new Hono()

    app.get('/', async (c) => c.json({ machines: await this.repo.listMachineDefs() }))

    app.post('/preflight', async (c) => {
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
      const SwarmId = typeof Body.swarm_id === 'string' ? Body.swarm_id.trim() : ''
      if (SwarmId === '') return bad(c, 'E_BAD_MACHINE', 'swarm_id 需为非空字符串')

      let Graph: SwarmGraphDef | undefined
      if (Body.graph !== undefined) {
        const Parsed = readSwarmDef(Body.graph)
        if (!Parsed.ok) return bad(c, 'E_BAD_BODY', Parsed.message)
        Graph = Parsed.value
      }

      try {
        return c.json(await this.assembly.preflight(SwarmId, Graph))
      } catch (Err) {
        logError('E_MACHINE_PREFLIGHT', String(Err))
        return c.json({ code: 'E_MACHINE_PREFLIGHT', message: '装配预检失败' }, 500)
      }
    })

    app.post('/:id/run', async (c) => {
      const Id = c.req.param('id').trim()
      if (Id === '') return bad(c, 'E_BAD_MACHINE_ID', 'machine 标识需为非空字符串')
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
      const Query = typeof Body.query === 'string' ? Body.query.trim() : ''
      if (Query === '') return bad(c, 'E_EMPTY_QUERY', '提问不能为空')

      try {
        return c.json(await this.runner.run(Id, Query, c.req.raw.signal))
      } catch (Err) {
        if (Err instanceof MachineRunError) {
          return c.json({
            code: Err.code,
            message: Err.message,
            ...(Err.errors === undefined ? {} : { detail: { errors: Err.errors } }),
          }, Err.status as 400)
        }
        logError('E_MACHINE_RUN', String(Err))
        return c.json({ code: 'E_MACHINE_RUN', message: '运行失败' }, 500)
      }
    })

    app.get('/:id', async (c) => {
      const Id = c.req.param('id')
      const Row = await this.repo.readMachineById(Id)
      if (Row === null) {
        return c.json({ code: 'E_MACHINE_NOT_FOUND', message: `machine 不存在: ${Id}` }, 404)
      }
      return c.json({
        machine_id: Row.id,
        name: Row.name,
        swarm_id: Row.swarm_id,
        enabled: Row.enabled,
        version: Row.version,
        created_at: Row.created_at,
        updated_at: Row.updated_at,
      })
    })

    app.put('/:id', async (c) => {
      const Id = c.req.param('id').trim()
      if (Id === '') return bad(c, 'E_BAD_MACHINE_ID', 'machine 标识需为非空字符串')
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')

      const Name = typeof Body.name === 'string' ? Body.name.trim() : ''
      if (Name === '') return bad(c, 'E_BAD_MACHINE', 'name 需为非空字符串')
      if (Name.length > NAME_MAX) return bad(c, 'E_BAD_MACHINE', `name 最长 ${NAME_MAX} 字符`)
      const SwarmId = typeof Body.swarm_id === 'string' ? Body.swarm_id.trim() : ''
      if (SwarmId === '') return bad(c, 'E_BAD_MACHINE', 'swarm_id 需为非空字符串')
      if (typeof Body.enabled !== 'boolean') return bad(c, 'E_BAD_MACHINE', 'enabled 需为布尔值')

      const Graph = await this.swarms.readSwarmById(SwarmId)
      if (Graph === null) {
        return bad(c, 'E_MACHINE_SWARM_NOT_FOUND', `绑定的 swarm 图不存在: ${SwarmId}`)
      }
      const Issues = validateNodeConfigs(Graph.nodes)
      if (Issues.length > 0) {
        return c.json({
          code: 'E_MACHINE_NODE_CONFIG',
          message: '绑定图的节点配置不完整',
          detail: { issues: Issues },
        }, 400)
      }

      try {
        const Saved = await this.repo.replaceMachineById(Id, { name: Name, swarm_id: SwarmId, enabled: Body.enabled })
        return c.json({ machine_id: Saved.id, version: Saved.version })
      } catch (Err) {
        if (foreignKeyViolation(Err)) {
          return bad(c, 'E_MACHINE_SWARM_NOT_FOUND', `绑定的 swarm 图不存在: ${SwarmId}`)
        }
        logError('E_MACHINE_SAVE', String(Err))
        return c.json({ code: 'E_MACHINE_SAVE', message: '保存 machine 失败' }, 500)
      }
    })

    return app
  }
}

function readSwarmDef(Value: unknown): { ok: true; value: SwarmGraphDef } | { ok: false; message: string } {
  if (Value === null || typeof Value !== 'object' || Array.isArray(Value)) {
    return { ok: false, message: 'graph 需为对象' }
  }
  const Body = Value as Record<string, unknown>
  if (!Array.isArray(Body.nodes) || Body.nodes.length === 0) {
    return { ok: false, message: 'graph.nodes 需为非空数组' }
  }
  if (Body.nodes.some((Item) => Item === null || typeof Item !== 'object' || Array.isArray(Item))) {
    return { ok: false, message: 'graph.nodes 每项需为对象' }
  }
  if (!Array.isArray(Body.edges)) {
    return { ok: false, message: 'graph.edges 需为数组' }
  }
  if (Body.edges.some((Item) => Item === null || typeof Item !== 'object' || Array.isArray(Item))) {
    return { ok: false, message: 'graph.edges 每项需为对象' }
  }
  if (typeof Body.output_node !== 'string' || Body.output_node.trim() === '') {
    return { ok: false, message: 'graph.output_node 必填' }
  }
  return {
    ok: true,
    value: { nodes: Body.nodes as SwarmNode[], edges: Body.edges as SwarmEdge[], output: Body.output_node },
  }
}

function readObject(c: Context): Promise<Record<string, unknown> | null> {
  return c.req.json().catch(() => null).then((Body) => {
    if (Body === null || typeof Body !== 'object' || Array.isArray(Body)) return null
    return Body as Record<string, unknown>
  })
}

function foreignKeyViolation(Err: unknown): boolean {
  let Current: unknown = Err
  while (Current !== null && typeof Current === 'object') {
    if ((Current as { code?: unknown }).code === '23503') return true
    Current = (Current as { cause?: unknown }).cause
  }
  return false
}

function bad(c: Context, Code: string, Message: string) {
  return c.json({ code: Code, message: Message }, 400)
}
