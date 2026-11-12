/**
 * swarm 图定义行 —— swarm_defs 的读写；按 id 寻址，PUT 走整图 upsert（首写 version=1，之后 version+1）。
 * 只做查询、行映射与版本递增，不校验图结构；校验归 swarm/graph.ts。
 * 本版没有停用入口，读不按 enabled 过滤（行存在即可读回）。
 * 本文件不碰组件注册表、不读 env。
 */

export { PostgresSwarmRepo, listSwarmDefs, readSwarmById, replaceSwarmById }
export type { SwarmRow, SwarmSummaryRow }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { asc, eq, sql } from 'drizzle-orm'
import { swarm_defs } from './orm/schema'
import { createOrm } from './orm/client'
import { DbHandle } from '../connection/db'

import type { Orm } from './orm/client'
import type { SwarmEdge, SwarmGraphDef, SwarmNode } from '../../swarm/graph'

interface SwarmRow {
  id: string
  version: number
  nodes: SwarmNode[]
  edges: SwarmEdge[]
  output_node: string
  enabled: boolean
  created_at: string
  updated_at: string
}

interface SwarmSummaryRow {
  id: string
  version: number
  enabled: boolean
}

interface SwarmRawRow {
  id: string
  version: number
  nodes: unknown
  edges: unknown
  output_node: string
  enabled: boolean
  created_at: Date | string
  updated_at: Date | string
}

function iso(Value: Date | string): string {
  return Value instanceof Date ? Value.toISOString() : Value
}

function arrayOf<T>(Value: unknown): T[] {
  return Array.isArray(Value) ? (Value as T[]) : []
}

function rowToSwarm(Row: SwarmRawRow): SwarmRow {
  return {
    id: Row.id,
    version: Number(Row.version),
    nodes: arrayOf<SwarmNode>(Row.nodes),
    edges: arrayOf<SwarmEdge>(Row.edges),
    output_node: Row.output_node,
    enabled: Row.enabled === true,
    created_at: iso(Row.created_at),
    updated_at: iso(Row.updated_at),
  }
}

async function readSwarmById(Db: Orm, Id: string): Promise<SwarmRow | null> {
  const Rows = await Db.select().from(swarm_defs).where(eq(swarm_defs.id, Id)).limit(1)
  const Row = Rows[0]
  return Row === undefined ? null : rowToSwarm(Row)
}

async function listSwarmDefs(Db: Orm): Promise<SwarmSummaryRow[]> {
  const Rows = await Db.select({
    id: swarm_defs.id,
    version: swarm_defs.version,
    enabled: swarm_defs.enabled,
  })
    .from(swarm_defs)
    .orderBy(asc(swarm_defs.id))
  return Rows.map((Row) => ({ id: Row.id, version: Number(Row.version), enabled: Row.enabled === true }))
}

async function replaceSwarmById(Db: Orm, Id: string, Def: SwarmGraphDef): Promise<SwarmRow> {
  const Rows = await Db.insert(swarm_defs)
    .values({ id: Id, nodes: Def.nodes, edges: Def.edges, output_node: Def.output })
    .onConflictDoUpdate({
      target: swarm_defs.id,
      set: {
        nodes: Def.nodes,
        edges: Def.edges,
        output_node: Def.output,
        version: sql`${swarm_defs.version} + 1`,
        updated_at: new Date(),
      },
    })
    .returning()
  return rowToSwarm(Rows[0]!)
}

@singleton()
class PostgresSwarmRepo {
  private readonly orm: Orm

  constructor(@inject(DbHandle) Db: DbHandle) {
    this.orm = createOrm(Db.pool)
  }

  readSwarmById(Id: string) {
    return readSwarmById(this.orm, Id)
  }

  listSwarmDefs() {
    return listSwarmDefs(this.orm)
  }

  replaceSwarmById(Id: string, Def: SwarmGraphDef) {
    return replaceSwarmById(this.orm, Id, Def)
  }
}
