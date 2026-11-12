/**
 * /swarm —— swarm 图定义的读取、整图替换与校验；裸 Hono，不进 hono-crud。
 * PUT 先过结构校验（逻辑交换表 → 端口可赋值 → 无环 → 输出节点），非法整图不落库；合法则按 id upsert（首写 v1，之后 +1）。
 * 无运行端点：执行图归后续 change。
 */

export { SwarmRoute }

import 'reflect-metadata'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { inject, injectable } from 'tsyringe'
import { PostgresSwarmRepo } from '../adapter/contract'
import { SwarmError, validateSwarmGraph } from '../swarm/graph'
import { logError } from '../trace/systemtrace/log'

import type { SwarmEdge, SwarmGraphDef, SwarmNode } from '../swarm/graph'

@injectable()
class SwarmRoute {
  private readonly repo: PostgresSwarmRepo

  constructor(@inject(PostgresSwarmRepo) Repo: PostgresSwarmRepo) {
    this.repo = Repo
  }

  build(): Hono {
    const app = new Hono()

    app.get('/', async (c) => c.json({ swarms: await this.repo.listSwarmDefs() }))

    app.get('/:id', async (c) => {
      const Id = c.req.param('id')
      const Row = await this.repo.readSwarmById(Id)
      if (Row === null) {
        return c.json({ code: 'E_SWARM_NOT_FOUND', message: `图不存在: ${Id}` }, 404)
      }
      return c.json({
        swarm_id: Row.id,
        version: Row.version,
        enabled: Row.enabled,
        graph: { nodes: Row.nodes, edges: Row.edges, output_node: Row.output_node },
        created_at: Row.created_at,
        updated_at: Row.updated_at,
      })
    })

    app.put('/:id', async (c) => {
      const Id = c.req.param('id').trim()
      if (Id === '') return bad(c, 'E_BAD_SWARM_ID', 'swarm_id 需为非空字符串')
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
      const Parsed = readSwarmDef(Body)
      if (!Parsed.ok) return bad(c, 'E_BAD_BODY', Parsed.message)
      try {
        validateSwarmGraph(Parsed.value)
      } catch (Err) {
        return validationError(c, Err)
      }

      const Saved = await this.repo.replaceSwarmById(Id, Parsed.value)
      return c.json({ swarm_id: Saved.id, version: Saved.version })
    })

    app.post('/validate', async (c) => {
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
      const Parsed = readSwarmDef(Body)
      if (!Parsed.ok) return bad(c, 'E_BAD_BODY', Parsed.message)
      try {
        validateSwarmGraph(Parsed.value)
        return c.json({ ok: true })
      } catch (Err) {
        if (Err instanceof SwarmError) {
          return c.json({
            ok: false,
            errors: [{
              node: Err.detail.node ?? null,
              edge: Err.detail.edge ?? null,
              port: Err.detail.port ?? null,
              path: Err.detail.path ?? null,
              reason: Err.message,
            }],
          })
        }
        logError('E_SWARM_VALIDATE', String(Err))
        return c.json({ code: 'E_SWARM_VALIDATE', message: '图校验失败' }, 500)
      }
    })

    return app
  }
}

function readObject(c: Context): Promise<Record<string, unknown> | null> {
  return c.req.json().catch(() => null).then((Body) => {
    if (Body === null || typeof Body !== 'object' || Array.isArray(Body)) return null
    return Body as Record<string, unknown>
  })
}

function readSwarmDef(Body: Record<string, unknown>): { ok: true; value: SwarmGraphDef } | { ok: false; message: string } {
  if (!Array.isArray(Body.nodes) || Body.nodes.length === 0) return { ok: false, message: 'nodes 需为非空数组' }
  if (Body.nodes.some((Item) => Item === null || typeof Item !== 'object' || Array.isArray(Item))) {
    return { ok: false, message: 'nodes 每项需为对象' }
  }
  if (!Array.isArray(Body.edges)) return { ok: false, message: 'edges 需为数组' }
  if (Body.edges.some((Item) => Item === null || typeof Item !== 'object' || Array.isArray(Item))) {
    return { ok: false, message: 'edges 每项需为对象' }
  }
  if (typeof Body.output_node !== 'string' || Body.output_node.trim() === '') {
    return { ok: false, message: 'output_node 必填' }
  }
  return { ok: true, value: { nodes: Body.nodes as SwarmNode[], edges: Body.edges as SwarmEdge[], output: Body.output_node } }
}

function validationError(c: Context, Err: unknown) {
  if (Err instanceof SwarmError) {
    return c.json({ code: Err.code, message: Err.message, detail: Err.detail }, 400)
  }
  logError('E_SWARM_VALIDATE', String(Err))
  return c.json({ code: 'E_SWARM_VALIDATE', message: '图校验失败' }, 500)
}

function bad(c: Context, Code: string, Message: string) {
  return c.json({ code: Code, message: Message }, 400)
}
