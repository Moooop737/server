/**
 * 四张表的 CRUD 注册 —— 唯一碰 hono-crud / @hono-crud/drizzle 的地方（ESM-only，必须动态 import）。
 * Tables 只写表 + 业务选择；tableName/schema/primaryKeys/时间戳/软删全部从 Drizzle 表对象与库列约定推出来。
 * 开启的端点是 list/read/create/update/delete；resources 只开 list/read（建/删必须走入库管线与取消语义）。
 * drizzle 适配器的 ListEndpoint 默认 sqlite，PgListEndpoint 把 dialect 改成 pg。
 * db 不在这里传入：drizzle 适配器每个请求从 Hono context 取 db，由入口的中间件 c.set('db', repo.orm) 提供。
 * 写端点必须在 entry.fields 给 zod（或用 createInsertSchema 生成）；只读表不需要 fields。
 */

import { getTableName } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'
import { z } from 'zod'
import { OpenAPIHono } from '@hono/zod-openapi'
import { messages, resources, sessions, traces } from '../adapter/contract'

export { createCrudRoot, registerAllCrud, CrudDoc }

interface TableEntry {
  table: any
  path: string
  tag: string
  fields?: any
  endpoints: any
  envelope: { listKey: string; itemKey: string; rawItem?: boolean }
}

const Tables: TableEntry[] = [
  {
    table: resources,
    path: '/resources',
    tag: 'Resources',
    endpoints: {
      list: {
        filtering: { fields: ['status', 'content_type', 'created_at', 'updated_at'] },
        search: { fields: ['title', 'source'] },
        sorting: { fields: ['created_at', 'updated_at', 'title', 'status'], default: 'created_at', defaultOrder: 'desc' },
        pagination: { defaultPerPage: 1000, maxPerPage: 1000 },
      },
      read: {},
    },
    envelope: { listKey: 'resources', itemKey: 'resource' },
  },
  {
    table: sessions,
    path: '/sessions',
    tag: 'Sessions',
    fields: z.object({ title: z.string().trim().min(1).optional() }),
    endpoints: {
      list: {
        filtering: { fields: ['created_at', 'updated_at'] },
        search: { fields: ['title'] },
        sorting: { fields: ['created_at', 'updated_at', 'title'], default: 'created_at', defaultOrder: 'desc' },
        pagination: { defaultPerPage: 1000, maxPerPage: 1000 },
      },
      read: {},
      create: { hooks: { before: (Data: any) => ({ ...Data, title: Data.title ?? '' }) } },
      update: {},
      delete: {},
    },
    envelope: { listKey: 'sessions', itemKey: 'session', rawItem: true },
  },
  {
    table: messages,
    path: '/messages',
    tag: 'Messages',
    fields: createInsertSchema(messages),
    endpoints: {
      list: {
        filtering: { fields: ['session_id', 'role', 'created_at'] },
        search: { fields: ['content'] },
        sorting: { fields: ['sequence', 'created_at'], default: 'sequence', defaultOrder: 'asc' },
        pagination: { defaultPerPage: 1000, maxPerPage: 1000 },
      },
      read: {},
      create: {},
      update: {},
      delete: {},
    },
    envelope: { listKey: 'messages', itemKey: 'message' },
  },
  {
    table: traces,
    path: '/traces',
    tag: 'Traces',
    fields: createInsertSchema(traces, {
      started_at: () => z.coerce.date(),
      ended_at: () => z.coerce.date().nullable(),
    }),
    endpoints: {
      list: {
        filtering: { fields: ['route', 'status', 'started_at', 'ended_at', 'session_id', 'resource_id'] },
        search: { fields: ['route', 'status', 'error_code'] },
        sorting: { fields: ['started_at', 'duration_ms'], default: 'started_at', defaultOrder: 'desc' },
        pagination: { defaultPerPage: 50, maxPerPage: 200 },
        fieldSelection: {
          enabled: true,
          blocked: ['payloads'],
          defaults: ['id', 'session_id', 'resource_id', 'route', 'http_status', 'started_at', 'ended_at', 'duration_ms', 'status', 'error_code', 'langfuse_trace_id', 'created_at'],
        },
      },
      create: {},
      update: {},
      delete: {},
    },
    envelope: { listKey: 'traces', itemKey: 'trace' },
  },
]

const CrudDoc = Tables.map((Entry) => ({
  path: Entry.path,
  endpoints: Object.keys(Entry.endpoints),
  listKey: Entry.envelope.listKey,
  itemKey: Entry.envelope.itemKey,
  rawItem: Entry.envelope.rawItem ?? false,
}))

async function createCrudRoot(): Promise<{ app: any; router: OpenAPIHono }> {
  const { fromHono } = await import('hono-crud')
  const router = new OpenAPIHono()
  return { app: fromHono(router), router }
}

async function registerAllCrud(app: any): Promise<void> {
  const { defineEndpoints, defineMeta, defineModel, registerCrud } = await import('hono-crud')
  const { DrizzleAdapters, DrizzleListEndpoint } = await import('@hono-crud/drizzle')

  class PgListEndpoint extends DrizzleListEndpoint {
    protected dialect = 'pg' as const
    _meta!: any
  }

  const PgAdapters = { ...DrizzleAdapters, ListEndpoint: PgListEndpoint }

  for (const Entry of Tables) {
    const Model = defineModel(modelOf(Entry.table, Entry.tag))
    const Meta = defineMeta({ model: Model, ...(Entry.fields ? { fields: Entry.fields } : {}) })
    registerCrud(app, Entry.path, defineEndpoints({ meta: Meta, ...Entry.endpoints }, PgAdapters), {
      responseEnvelope: envelopeFor(Entry.envelope.listKey, Entry.envelope.itemKey, Entry.envelope.rawItem),
    })
  }
}

function modelOf(Table: any, Tag: string) {
  const Config = getTableConfig(Table)
  const Columns: string[] = Config.columns.map((Column: any) => Column.name)
  const PrimaryKeys: string[] = Config.columns.filter((Column: any) => Column.primary).map((Column: any) => Column.name)
  if (PrimaryKeys.length === 0) throw new Error(`表 ${Config.name} 没有主键，hono-crud 需要 primaryKeys`)

  return {
    tableName: getTableName(Table),
    table: Table,
    schema: createSelectSchema(Table),
    primaryKeys: PrimaryKeys,
    tag: Tag,
    ...(Columns.includes('deleted_at') ? { softDelete: { field: 'deleted_at' } } : {}),
    ...(Columns.includes('created_at') && Columns.includes('updated_at')
      ? { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
      : { timestamps: false }),
  }
}

function envelopeFor(ListKey: string, ItemKey: string, RawItem = false) {
  return {
    success: (Result: unknown, Info?: unknown) =>
      Array.isArray(Result)
        ? { [ListKey]: Result, ...(Info ? { pagination: Info } : {}) }
        : RawItem ? Result : { [ItemKey]: Result },
    error: (Err: { code: string; message: string }) => ({ code: Err.code, message: Err.message }),
  }
}
