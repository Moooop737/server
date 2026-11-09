/**
 * 配置行 —— providers / models 的读写；默认行是 models 里 kind='default' 的指针行。
 * 只做查询与行映射：不校验 kind / base_url / dimensions，校验归 routes/config.ts，DB CHECK 兜底。
 * readConfig 在一个 REPEATABLE READ 事务里读三张表，热更新拿到的是一致快照。
 * deleteModel 在一个事务里先删指向它的默认行，再删模型行。
 * 本文件不加密、不解密；headers_ciphertext 只是搬运密文。
 */

export {
  listProviders, getProvider, getProviderByName, createProvider,
  setProviderBaseUrl, setProviderEnabled, setProviderApiKey, setProviderHeaders, setProviderQuery, setProviderOptions, deleteProvider,
  listModels, getModel, createModel, updateModel, deleteModel,
  listDefaults, getDefault, upsertDefault, deleteDefault, readConfig,
}
export type {
  ProviderKind, ModelKind, ProviderRow, ModelWithProvider, DefaultRow,
  ConfigSnapshot, CreateProviderInput, CreateModelInput, UpdateModelInput,
}

import { and, asc, eq, ne } from 'drizzle-orm'
import { models, providers } from './orm/schema'
import type { Orm } from './orm/client'

type ProviderKind = 'deepseek' | 'dashscope' | 'openai-compatible' | 'ollama'
type ModelKind = 'language' | 'embedding'

interface ProviderRow {
  id: string
  name: string
  kind: ProviderKind
  base_url: string | null
  api_key_ciphertext: string | null
  headers_ciphertext: string | null
  query: Record<string, string>
  options: Record<string, unknown>
  enabled: boolean
  created_at: string
  updated_at: string
}

interface ModelWithProvider {
  id: string
  provider_id: string
  provider_name: string
  provider_kind: ProviderKind
  model_id: string
  kind: ModelKind
  display_name: string
  dimensions: number | null
  enabled: boolean
  created_at: string
  updated_at: string
}

interface DefaultRow {
  id: 'default' | 'embedding'
  provider_id: string
  provider_name: string
  provider_kind: ProviderKind
  model_id: string
  display_name: string
  enabled: boolean
  created_at: string
  updated_at: string
}

interface ConfigSnapshot {
  providers: ProviderRow[]
  models: ModelWithProvider[]
  defaults: DefaultRow[]
}

interface CreateProviderInput {
  name: string
  kind: ProviderKind
  base_url: string | null
  options?: Record<string, unknown>
}

interface CreateModelInput {
  id: string
  provider_id: string
  model_id: string
  kind: ModelKind
  display_name: string
  dimensions: number | null
  enabled?: boolean
}

interface UpdateModelInput {
  display_name: string
  dimensions: number | null
  enabled: boolean
}

const ModelColumns = {
  id: models.id,
  provider_id: models.provider_id,
  provider_name: providers.name,
  provider_kind: providers.kind,
  model_id: models.model_id,
  kind: models.kind,
  display_name: models.display_name,
  dimensions: models.dimensions,
  enabled: models.enabled,
  created_at: models.created_at,
  updated_at: models.updated_at,
}

const DefaultColumns = {
  id: models.id,
  provider_id: models.provider_id,
  provider_name: providers.name,
  provider_kind: providers.kind,
  model_id: models.model_id,
  display_name: models.display_name,
  enabled: models.enabled,
  created_at: models.created_at,
  updated_at: models.updated_at,
}

function iso(Value: Date | string): string {
  return Value instanceof Date ? Value.toISOString() : Value
}

function queryObject(Value: unknown): Record<string, string> {
  if (Value === null || typeof Value !== 'object' || Array.isArray(Value)) return {}
  const Out: Record<string, string> = {}
  for (const [Key, Item] of Object.entries(Value)) {
    if (typeof Item === 'string') Out[Key] = Item
  }
  return Out
}

function jsonObject(Value: unknown): Record<string, unknown> {
  if (Value === null || typeof Value !== 'object' || Array.isArray(Value)) return {}
  return { ...(Value as Record<string, unknown>) }
}

function rowToProvider(Row: any): ProviderRow {
  return {
    id: Row.id,
    name: Row.name,
    kind: Row.kind as ProviderKind,
    base_url: Row.base_url ?? null,
    api_key_ciphertext: Row.api_key_ciphertext ?? null,
    headers_ciphertext: Row.headers_ciphertext ?? null,
    query: queryObject(Row.query),
    options: jsonObject(Row.options),
    enabled: Row.enabled === true,
    created_at: iso(Row.created_at),
    updated_at: iso(Row.updated_at),
  }
}

function rowToModel(Row: any): ModelWithProvider {
  return {
    id: Row.id,
    provider_id: Row.provider_id,
    provider_name: Row.provider_name,
    provider_kind: Row.provider_kind as ProviderKind,
    model_id: Row.model_id,
    kind: Row.kind as ModelKind,
    display_name: Row.display_name,
    dimensions: Row.dimensions === null || Row.dimensions === undefined ? null : Number(Row.dimensions),
    enabled: Row.enabled === true,
    created_at: iso(Row.created_at),
    updated_at: iso(Row.updated_at),
  }
}

function rowToDefault(Row: any): DefaultRow {
  return {
    id: Row.id as DefaultRow['id'],
    provider_id: Row.provider_id,
    provider_name: Row.provider_name,
    provider_kind: Row.provider_kind as ProviderKind,
    model_id: Row.model_id,
    display_name: Row.display_name,
    enabled: Row.enabled === true,
    created_at: iso(Row.created_at),
    updated_at: iso(Row.updated_at),
  }
}

function mustRow<T>(Rows: T[], Message: string): T {
  const Row = Rows[0]
  if (Row === undefined) throw new Error(Message)
  return Row
}

async function listProviders(Db: Orm): Promise<ProviderRow[]> {
  const Rows = await Db.select().from(providers).orderBy(asc(providers.name))
  return Rows.map(rowToProvider)
}

async function getProvider(Db: Orm, Id: string): Promise<ProviderRow | null> {
  const Rows = await Db.select().from(providers).where(eq(providers.id, Id)).limit(1)
  const Row = Rows[0]
  return Row === undefined ? null : rowToProvider(Row)
}

async function getProviderByName(Db: Orm, Name: string): Promise<ProviderRow | null> {
  const Rows = await Db.select().from(providers).where(eq(providers.name, Name)).limit(1)
  const Row = Rows[0]
  return Row === undefined ? null : rowToProvider(Row)
}

async function createProvider(Db: Orm, Input: CreateProviderInput): Promise<ProviderRow> {
  const Rows = await Db.insert(providers).values({
    name: Input.name,
    kind: Input.kind,
    base_url: Input.base_url,
    options: Input.options ?? {},
  }).returning()
  return rowToProvider(mustRow(Rows, 'createProvider 未返回行'))
}

async function setProviderBaseUrl(Db: Orm, Id: string, BaseUrl: string | null): Promise<boolean> {
  const Rows = await Db.update(providers)
    .set({ base_url: BaseUrl, updated_at: new Date() })
    .where(eq(providers.id, Id))
    .returning({ id: providers.id })
  return Rows.length > 0
}

async function setProviderEnabled(Db: Orm, Id: string, Enabled: boolean): Promise<boolean> {
  const Rows = await Db.update(providers)
    .set({ enabled: Enabled, updated_at: new Date() })
    .where(eq(providers.id, Id))
    .returning({ id: providers.id })
  return Rows.length > 0
}

async function setProviderApiKey(Db: Orm, Id: string, Ciphertext: string | null): Promise<boolean> {
  const Rows = await Db.update(providers)
    .set({ api_key_ciphertext: Ciphertext, updated_at: new Date() })
    .where(eq(providers.id, Id))
    .returning({ id: providers.id })
  return Rows.length > 0
}

async function setProviderHeaders(Db: Orm, Id: string, Ciphertext: string | null): Promise<boolean> {
  const Rows = await Db.update(providers)
    .set({ headers_ciphertext: Ciphertext, updated_at: new Date() })
    .where(eq(providers.id, Id))
    .returning({ id: providers.id })
  return Rows.length > 0
}

async function setProviderQuery(Db: Orm, Id: string, Query: Record<string, string>): Promise<boolean> {
  const Rows = await Db.update(providers)
    .set({ query: Query, updated_at: new Date() })
    .where(eq(providers.id, Id))
    .returning({ id: providers.id })
  return Rows.length > 0
}

async function setProviderOptions(Db: Orm, Id: string, Options: Record<string, unknown>): Promise<boolean> {
  const Rows = await Db.update(providers)
    .set({ options: Options, updated_at: new Date() })
    .where(eq(providers.id, Id))
    .returning({ id: providers.id })
  return Rows.length > 0
}

async function deleteProvider(Db: Orm, Id: string): Promise<boolean> {
  const Rows = await Db.delete(providers).where(eq(providers.id, Id)).returning({ id: providers.id })
  return Rows.length > 0
}

async function listModels(Db: Orm): Promise<ModelWithProvider[]> {
  const Rows = await Db.select(ModelColumns)
    .from(models)
    .innerJoin(providers, eq(providers.id, models.provider_id))
    .where(ne(models.kind, 'default'))
    .orderBy(asc(providers.name), asc(models.kind), asc(models.model_id))
  return Rows.map(rowToModel)
}

async function getModel(Db: Orm, Id: string): Promise<ModelWithProvider | null> {
  const Rows = await Db.select(ModelColumns)
    .from(models)
    .innerJoin(providers, eq(providers.id, models.provider_id))
    .where(and(ne(models.kind, 'default'), eq(models.id, Id)))
    .limit(1)
  const Row = Rows[0]
  return Row === undefined ? null : rowToModel(Row)
}

async function createModel(Db: Orm, Input: CreateModelInput): Promise<ModelWithProvider> {
  const Rows = await Db.insert(models).values({
    id: Input.id,
    provider_id: Input.provider_id,
    model_id: Input.model_id,
    kind: Input.kind,
    display_name: Input.display_name,
    dimensions: Input.dimensions,
    enabled: Input.enabled ?? true,
  }).returning({ id: models.id })
  const Row = mustRow(Rows, 'createModel 未返回行')
  const Model = await getModel(Db, Row.id)
  if (Model === null) throw new Error(`createModel 后读不到模型 ${Row.id}`)
  return Model
}

async function updateModel(Db: Orm, Id: string, Input: UpdateModelInput): Promise<ModelWithProvider | null> {
  const Rows = await Db.update(models)
    .set({ display_name: Input.display_name, dimensions: Input.dimensions, enabled: Input.enabled, updated_at: new Date() })
    .where(and(eq(models.id, Id), ne(models.kind, 'default')))
    .returning({ id: models.id })
  if (Rows.length === 0) return null
  return getModel(Db, Id)
}

async function deleteModel(Db: Orm, Id: string): Promise<boolean> {
  return Db.transaction(async (Tx) => {
    const Target = await Tx.select({ provider_id: models.provider_id, model_id: models.model_id })
      .from(models)
      .where(and(eq(models.id, Id), ne(models.kind, 'default')))
      .limit(1)
    const Row = Target[0]
    if (Row === undefined) return false
    await Tx.delete(models).where(and(
      eq(models.kind, 'default'),
      eq(models.provider_id, Row.provider_id),
      eq(models.model_id, Row.model_id),
    ))
    const Removed = await Tx.delete(models)
      .where(and(eq(models.id, Id), ne(models.kind, 'default')))
      .returning({ id: models.id })
    return Removed.length > 0
  })
}

async function listDefaults(Db: Orm): Promise<DefaultRow[]> {
  const Rows = await Db.select(DefaultColumns)
    .from(models)
    .innerJoin(providers, eq(providers.id, models.provider_id))
    .where(eq(models.kind, 'default'))
    .orderBy(asc(models.id))
  return Rows.map(rowToDefault)
}

async function getDefault(Db: Orm, Id: 'default' | 'embedding'): Promise<DefaultRow | null> {
  const Rows = await Db.select(DefaultColumns)
    .from(models)
    .innerJoin(providers, eq(providers.id, models.provider_id))
    .where(and(eq(models.kind, 'default'), eq(models.id, Id)))
    .limit(1)
  const Row = Rows[0]
  return Row === undefined ? null : rowToDefault(Row)
}

async function upsertDefault(
  Db: Orm,
  Id: 'default' | 'embedding',
  ProviderId: string,
  ModelId: string,
  DisplayName: string,
): Promise<DefaultRow> {
  await Db.insert(models).values({
    id: Id,
    provider_id: ProviderId,
    model_id: ModelId,
    kind: 'default',
    display_name: DisplayName,
    dimensions: null,
    enabled: true,
  }).onConflictDoUpdate({
    target: models.id,
    set: {
      provider_id: ProviderId,
      model_id: ModelId,
      display_name: DisplayName,
      enabled: true,
      updated_at: new Date(),
    },
  })
  const Default = await getDefault(Db, Id)
  if (Default === null) throw new Error(`upsertDefault 后读不到默认行 ${Id}`)
  return Default
}

async function deleteDefault(Db: Orm, Id: 'default' | 'embedding'): Promise<boolean> {
  const Rows = await Db.delete(models)
    .where(and(eq(models.id, Id), eq(models.kind, 'default')))
    .returning({ id: models.id })
  return Rows.length > 0
}

async function readConfig(Db: Orm): Promise<ConfigSnapshot> {
  return Db.transaction(async (Tx) => {
    const ProviderRows = await Tx.select().from(providers).orderBy(asc(providers.name))
    const ModelRows = await Tx.select(ModelColumns)
      .from(models)
      .innerJoin(providers, eq(providers.id, models.provider_id))
      .where(ne(models.kind, 'default'))
      .orderBy(asc(providers.name), asc(models.kind), asc(models.model_id))
    const DefaultRows = await Tx.select(DefaultColumns)
      .from(models)
      .innerJoin(providers, eq(providers.id, models.provider_id))
      .where(eq(models.kind, 'default'))
      .orderBy(asc(models.id))
    return {
      providers: ProviderRows.map(rowToProvider),
      models: ModelRows.map(rowToModel),
      defaults: DefaultRows.map(rowToDefault),
    }
  }, { isolationLevel: 'repeatable read' })
}
