/**
 * 管线定义行 —— pipeline_defs 的读写；T2 只有 id='default' 一行，读写按 id 寻址以便将来多管线。
 * 只做查询、行映射与 version+1：不校验组件与边，校验归 retrieve/pipeline 的装配器。
 * 读只认 enabled=true 的行；写不建行（行由迁移种下），更新不到返回 null。
 * 本文件不碰组件注册表、不读 env。
 */

export { PostgresPipelineRepo, listPipelines, readById, readDefault, replaceById, replaceDefault }
export type { PipelineRow, PipelineSummaryRow }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { and, asc, eq, sql } from 'drizzle-orm'
import { pipeline_defs } from './orm/schema'
import { createOrm } from './orm/client'
import { DbHandle } from '../connection/db'

import type { Orm } from './orm/client'
import type { PipelineNode } from '../../retrieve/pipeline/pipeline'

interface PipelineRow {
  id: string
  kind: 'retrieval'
  version: number
  nodes: PipelineNode[]
  output_node: string | null
  enabled: boolean
  created_at: string
  updated_at: string
}

interface PipelineSummaryRow {
  id: string
  version: number
  enabled: boolean
}

interface PipelineRawRow {
  id: string
  kind: string
  version: number
  nodes: unknown
  output_node: string | null
  enabled: boolean
  created_at: Date | string
  updated_at: Date | string
}

function iso(Value: Date | string): string {
  return Value instanceof Date ? Value.toISOString() : Value
}

function nodeArray(Value: unknown): PipelineNode[] {
  return Array.isArray(Value) ? (Value as PipelineNode[]) : []
}

function rowToPipeline(Row: PipelineRawRow): PipelineRow {
  return {
    id: Row.id,
    kind: 'retrieval',
    version: Number(Row.version),
    nodes: nodeArray(Row.nodes),
    output_node: Row.output_node ?? null,
    enabled: Row.enabled === true,
    created_at: iso(Row.created_at),
    updated_at: iso(Row.updated_at),
  }
}

async function readById(Db: Orm, Id: string): Promise<PipelineRow | null> {
  const Rows = await Db.select()
    .from(pipeline_defs)
    .where(and(eq(pipeline_defs.id, Id), eq(pipeline_defs.enabled, true)))
    .limit(1)
  const Row = Rows[0]
  return Row === undefined ? null : rowToPipeline(Row)
}

async function readDefault(Db: Orm): Promise<PipelineRow | null> {
  return readById(Db, 'default')
}

async function listPipelines(Db: Orm): Promise<PipelineSummaryRow[]> {
  const Rows = await Db.select({
    id: pipeline_defs.id,
    version: pipeline_defs.version,
    enabled: pipeline_defs.enabled,
  })
    .from(pipeline_defs)
    .orderBy(asc(pipeline_defs.id))
  return Rows.map((Row) => ({ id: Row.id, version: Number(Row.version), enabled: Row.enabled === true }))
}

async function replaceById(Db: Orm, Id: string, Nodes: PipelineNode[], OutputNode: string | null): Promise<PipelineRow | null> {
  const Rows = await Db.update(pipeline_defs)
    .set({ nodes: Nodes, output_node: OutputNode, version: sql`${pipeline_defs.version} + 1`, updated_at: new Date() })
    .where(and(eq(pipeline_defs.id, Id), eq(pipeline_defs.enabled, true)))
    .returning()
  const Row = Rows[0]
  return Row === undefined ? null : rowToPipeline(Row)
}

async function replaceDefault(Db: Orm, Nodes: PipelineNode[], OutputNode: string | null): Promise<PipelineRow | null> {
  return replaceById(Db, 'default', Nodes, OutputNode)
}

@singleton()
class PostgresPipelineRepo {
  private readonly orm: Orm

  constructor(@inject(DbHandle) Db: DbHandle) {
    this.orm = createOrm(Db.pool)
  }

  readDefault() {
    return readDefault(this.orm)
  }

  readById(Id: string) {
    return readById(this.orm, Id)
  }

  listPipelines() {
    return listPipelines(this.orm)
  }

  replaceById(Id: string, Nodes: PipelineNode[], OutputNode: string | null) {
    return replaceById(this.orm, Id, Nodes, OutputNode)
  }

  replaceDefault(Nodes: PipelineNode[], OutputNode: string | null) {
    return replaceDefault(this.orm, Nodes, OutputNode)
  }
}
