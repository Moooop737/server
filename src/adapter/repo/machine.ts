/**
 * machine 定义行 —— machine_defs 的读写；按 id 寻址，PUT 走整机 upsert（首写 version=1，之后 version+1）。
 * 只做查询、行映射与版本递增，不校验绑定图与节点配置；校验归 routes/machine.ts。
 * 本文件不碰 swarm 图、不读 env。
 */

export { PostgresMachineRepo, listMachineDefs, readMachineById, replaceMachineById }
export type { MachineRow, MachineSummaryRow, MachineInput }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { asc, eq, sql } from 'drizzle-orm'
import { machine_defs } from './orm/schema'
import { createOrm } from './orm/client'
import { DbHandle } from '../connection/db'

import type { Orm } from './orm/client'

interface MachineRow {
  id: string
  name: string
  swarm_id: string
  enabled: boolean
  version: number
  created_at: string
  updated_at: string
}

interface MachineSummaryRow {
  id: string
  name: string
  swarm_id: string
  enabled: boolean
  version: number
}

interface MachineInput {
  name: string
  swarm_id: string
  enabled: boolean
}

interface MachineRawRow {
  id: string
  name: string
  swarm_id: string
  enabled: boolean
  version: number
  created_at: Date | string
  updated_at: Date | string
}

function iso(Value: Date | string): string {
  return Value instanceof Date ? Value.toISOString() : Value
}

function rowToMachine(Row: MachineRawRow): MachineRow {
  return {
    id: Row.id,
    name: Row.name,
    swarm_id: Row.swarm_id,
    enabled: Row.enabled === true,
    version: Number(Row.version),
    created_at: iso(Row.created_at),
    updated_at: iso(Row.updated_at),
  }
}

async function readMachineById(Db: Orm, Id: string): Promise<MachineRow | null> {
  const Rows = await Db.select().from(machine_defs).where(eq(machine_defs.id, Id)).limit(1)
  const Row = Rows[0]
  return Row === undefined ? null : rowToMachine(Row)
}

async function listMachineDefs(Db: Orm): Promise<MachineSummaryRow[]> {
  const Rows = await Db.select({
    id: machine_defs.id,
    name: machine_defs.name,
    swarm_id: machine_defs.swarm_id,
    enabled: machine_defs.enabled,
    version: machine_defs.version,
  })
    .from(machine_defs)
    .orderBy(asc(machine_defs.id))
  return Rows.map((Row) => ({
    id: Row.id,
    name: Row.name,
    swarm_id: Row.swarm_id,
    enabled: Row.enabled === true,
    version: Number(Row.version),
  }))
}

async function replaceMachineById(Db: Orm, Id: string, Input: MachineInput): Promise<MachineRow> {
  const Rows = await Db.insert(machine_defs)
    .values({ id: Id, name: Input.name, swarm_id: Input.swarm_id, enabled: Input.enabled })
    .onConflictDoUpdate({
      target: machine_defs.id,
      set: {
        name: Input.name,
        swarm_id: Input.swarm_id,
        enabled: Input.enabled,
        version: sql`${machine_defs.version} + 1`,
        updated_at: new Date(),
      },
    })
    .returning()
  return rowToMachine(Rows[0]!)
}

@singleton()
class PostgresMachineRepo {
  private readonly orm: Orm

  constructor(@inject(DbHandle) Db: DbHandle) {
    this.orm = createOrm(Db.pool)
  }

  readMachineById(Id: string) {
    return readMachineById(this.orm, Id)
  }

  listMachineDefs() {
    return listMachineDefs(this.orm)
  }

  replaceMachineById(Id: string, Input: MachineInput) {
    return replaceMachineById(this.orm, Id, Input)
  }
}
