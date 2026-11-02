/**
 * 评测题集与配置行 —— eval_datasets / eval_cases / eval_configs 的读/写；eval_runs 只做计数。
 * 三张表住「选中的库」：共享模式是主库，隔离模式是评测库；调用方一律经 EvalAssembly.repo。
 * config 是 jsonb 文档，本层不窄化也不校验（模型在册、数值范围归 routes/eval.ts）。
 * gold 是 [{ data_uri, chunk_index, content_prefix }]；负例必须为空数组（DB CHECK 兜底）。
 * 数据集删除不级联 runs：有 run 时 eval_runs.dataset_id 的 RESTRICT 会拒绝；本层先给计数，由路由决定怎么回。
 * 复制（数据集 / 配置）只改 id 与 name，不动原件；名字自动找空位（xxx 副本 / xxx 副本 2）。
 * 复制名探测里的 Base 走 LIKE 转义，名字本身带 % / _ 时不当通配符。
 */

export {
  listDatasets, getDataset, createDataset, updateDataset, setDatasetBaseline, countRunsOfDataset, deleteDataset, duplicateDataset,
  listCases, getCase, createCase, updateCase, deleteCase, nextCaseKey, upsertCase,
  listConfigs, getConfig, createConfig, updateConfig, deleteConfig, duplicateConfig,
}
export type { EvalDataset, EvalCase, EvalGold, EvalAssertion, EvalAssertions, EvalConfig, EvalConfigKind, EvalCaseInput }

import { and, asc, count, eq, like, or, sql } from 'drizzle-orm'
import { eval_cases, eval_configs, eval_datasets, eval_runs } from './orm/schema'
import type { Orm } from './orm/client'

type EvalConfigKind = 'run' | 'metric'

interface EvalGold {
  data_uri: string
  chunk_index: number
  content_prefix: string
}

interface EvalAssertion {
  text: string
  regex: boolean
}

interface EvalAssertions {
  expect: EvalAssertion[]
  reject: EvalAssertion[]
}

interface EvalDataset {
  id: string
  name: string
  note: string
  baseline_run_id: string | null
  case_count: number
  created_at: string
  updated_at: string
}

interface EvalCase {
  id: string
  dataset_id: string
  case_key: string
  level: string
  query: string
  negative: boolean
  note: string
  gold: EvalGold[]
  assertions: EvalAssertions
  created_at: string
  updated_at: string
}

interface EvalCaseInput {
  case_key?: string
  level: string
  query: string
  negative: boolean
  note: string
  gold: EvalGold[]
  assertions?: EvalAssertions
}

interface EvalConfig {
  id: string
  kind: EvalConfigKind
  name: string
  config: Record<string, unknown>
  created_at: string
  updated_at: string
}

type SelectExecutor = Pick<Orm, 'select'>

const DatasetColumns = {
  id: eval_datasets.id,
  name: eval_datasets.name,
  note: eval_datasets.note,
  baseline_run_id: eval_datasets.baseline_run_id,
  case_count: sql<number>`(SELECT COUNT(*)::int FROM eval_cases c WHERE c.dataset_id = eval_datasets.id)`,
  created_at: eval_datasets.created_at,
  updated_at: eval_datasets.updated_at,
}

function iso(v: Date | null): string | null {
  return v === null ? null : v.toISOString()
}

function rowToDataset(r: any): EvalDataset {
  return {
    id: r.id,
    name: r.name,
    note: r.note,
    baseline_run_id: r.baseline_run_id ?? null,
    case_count: Number(r.case_count ?? 0),
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  }
}

function rowToCase(r: any): EvalCase {
  return {
    id: r.id,
    dataset_id: r.dataset_id,
    case_key: r.case_key,
    level: r.level,
    query: r.query,
    negative: r.negative,
    note: r.note,
    gold: Array.isArray(r.gold) ? (r.gold as EvalGold[]) : [],
    assertions: rowAssertions(r.assertions),
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  }
}

function rowToConfig(r: any): EvalConfig {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    config: r.config !== null && typeof r.config === 'object' && !Array.isArray(r.config) ? (r.config as Record<string, unknown>) : {},
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  }
}

function emptyAssertions(): EvalAssertions {
  return { expect: [], reject: [] }
}

function rowAssertions(Value: unknown): EvalAssertions {
  if (Value === null || typeof Value !== 'object' || Array.isArray(Value)) return emptyAssertions()
  const Row = Value as { expect?: unknown; reject?: unknown }
  return { expect: assertionList(Row.expect), reject: assertionList(Row.reject) }
}

function assertionList(Value: unknown): EvalAssertion[] {
  if (!Array.isArray(Value)) return []
  return Value.flatMap((Item) => {
    if (Item === null || typeof Item !== 'object' || Array.isArray(Item)) return []
    const Row = Item as { text?: unknown; regex?: unknown }
    if (typeof Row.text !== 'string' || Row.text.trim() === '') return []
    return [{ text: Row.text, regex: Row.regex === true }]
  })
}

async function listDatasets(Db: Orm): Promise<EvalDataset[]> {
  const rows = await Db.select(DatasetColumns)
    .from(eval_datasets)
    .orderBy(asc(eval_datasets.created_at), asc(eval_datasets.id))
  return rows.map(rowToDataset)
}

async function getDataset(Db: Orm, Id: string): Promise<EvalDataset | null> {
  const rows = await Db.select(DatasetColumns)
    .from(eval_datasets)
    .where(eq(eval_datasets.id, Id))
    .limit(1)
  return rows[0] ? rowToDataset(rows[0]) : null
}

async function createDataset(Db: Orm, Data: { name: string; note: string }): Promise<EvalDataset> {
  const rows = await Db.insert(eval_datasets)
    .values({ name: Data.name, note: Data.note })
    .returning()
  return rowToDataset(rows[0])
}

async function updateDataset(Db: Orm, Id: string, Data: { name: string; note: string }): Promise<EvalDataset | null> {
  const rows = await Db.update(eval_datasets)
    .set({ name: Data.name, note: Data.note, updated_at: sql`now()` })
    .where(eq(eval_datasets.id, Id))
    .returning()
  return rows[0] ? { ...rowToDataset(rows[0]), case_count: await caseCount(Db, Id) } : null
}

async function setDatasetBaseline(Db: Orm, Id: string, RunId: string): Promise<EvalDataset | null> {
  const rows = await Db.update(eval_datasets)
    .set({ baseline_run_id: RunId, updated_at: sql`now()` })
    .where(eq(eval_datasets.id, Id))
    .returning()
  return rows[0] ? { ...rowToDataset(rows[0]), case_count: await caseCount(Db, Id) } : null
}

async function caseCount(Db: Orm, DatasetId: string): Promise<number> {
  const rows = await Db.select({ total: count() }).from(eval_cases).where(eq(eval_cases.dataset_id, DatasetId))
  return rows[0]!.total
}

async function countRunsOfDataset(Db: Orm, DatasetId: string): Promise<number> {
  const rows = await Db.select({ total: count() }).from(eval_runs).where(eq(eval_runs.dataset_id, DatasetId))
  return rows[0]!.total
}

async function deleteDataset(Db: Orm, Id: string): Promise<boolean> {
  const rows = await Db.delete(eval_datasets).where(eq(eval_datasets.id, Id)).returning({ id: eval_datasets.id })
  return rows.length === 1
}

async function duplicateDataset(Db: Orm, Id: string): Promise<EvalDataset | null> {
  return Db.transaction(async (Tx) => {
    const SrcRows = await Tx.select().from(eval_datasets).where(eq(eval_datasets.id, Id)).limit(1)
    const Src = SrcRows[0]
    if (!Src) return null
    const Name = await freeCopyName(Tx, 'eval_datasets', Src.name)
    const CopyRows = await Tx.insert(eval_datasets)
      .values({ name: Name, note: Src.note })
      .returning()
    const Copy = CopyRows[0]!
    const Cases = await Tx.select({
      case_key: eval_cases.case_key,
      level: eval_cases.level,
      query: eval_cases.query,
      negative: eval_cases.negative,
      note: eval_cases.note,
      gold: eval_cases.gold,
      assertions: eval_cases.assertions,
    }).from(eval_cases).where(eq(eval_cases.dataset_id, Id))
    if (Cases.length > 0) {
      await Tx.insert(eval_cases).values(Cases.map((CaseRow) => ({ ...CaseRow, dataset_id: Copy.id })))
    }
    return { ...rowToDataset(Copy), case_count: Cases.length }
  })
}

async function listCases(Db: Orm, DatasetId: string): Promise<EvalCase[]> {
  const rows = await Db.select()
    .from(eval_cases)
    .where(eq(eval_cases.dataset_id, DatasetId))
    .orderBy(asc(eval_cases.case_key), asc(eval_cases.id))
  return rows.map(rowToCase)
}

async function getCase(Db: Orm, Id: string): Promise<EvalCase | null> {
  const rows = await Db.select().from(eval_cases).where(eq(eval_cases.id, Id)).limit(1)
  return rows[0] ? rowToCase(rows[0]) : null
}

async function nextCaseKey(Db: Orm, DatasetId: string, Level: string): Promise<string> {
  const rows = await Db.select({ case_key: eval_cases.case_key })
    .from(eval_cases)
    .where(and(eq(eval_cases.dataset_id, DatasetId), eq(eval_cases.level, Level)))
  const Taken = new Set<string>(rows.map((Row) => Row.case_key))
  let N = 1
  while (Taken.has(`${Level}-N${N}`)) N += 1
  return `${Level}-N${N}`
}

async function createCase(Db: Orm, DatasetId: string, Data: EvalCaseInput): Promise<EvalCase> {
  const Key = Data.case_key ?? await nextCaseKey(Db, DatasetId, Data.level)
  const rows = await Db.insert(eval_cases)
    .values({
      dataset_id: DatasetId,
      case_key: Key,
      level: Data.level,
      query: Data.query,
      negative: Data.negative,
      note: Data.note,
      gold: Data.gold,
      assertions: Data.assertions ?? emptyAssertions(),
    })
    .returning()
  return rowToCase(rows[0])
}

async function updateCase(Db: Orm, Id: string, Data: Omit<EvalCaseInput, 'case_key'>): Promise<EvalCase | null> {
  const rows = await Db.update(eval_cases)
    .set({
      level: Data.level,
      query: Data.query,
      negative: Data.negative,
      note: Data.note,
      gold: Data.gold,
      assertions: Data.assertions ?? emptyAssertions(),
      updated_at: sql`now()`,
    })
    .where(eq(eval_cases.id, Id))
    .returning()
  return rows[0] ? rowToCase(rows[0]) : null
}

async function deleteCase(Db: Orm, Id: string): Promise<boolean> {
  const rows = await Db.delete(eval_cases).where(eq(eval_cases.id, Id)).returning({ id: eval_cases.id })
  return rows.length === 1
}

async function upsertCase(Db: Orm, DatasetId: string, Data: EvalCaseInput & { case_key: string }): Promise<EvalCase> {
  const rows = await Db.insert(eval_cases)
    .values({
      dataset_id: DatasetId,
      case_key: Data.case_key,
      level: Data.level,
      query: Data.query,
      negative: Data.negative,
      note: Data.note,
      gold: Data.gold,
      assertions: Data.assertions ?? emptyAssertions(),
    })
    .onConflictDoUpdate({
      target: [eval_cases.dataset_id, eval_cases.case_key],
      set: {
        level: Data.level,
        query: Data.query,
        negative: Data.negative,
        note: Data.note,
        gold: Data.gold,
        ...(Data.assertions === undefined ? {} : { assertions: Data.assertions }),
        updated_at: sql`now()`,
      },
    })
    .returning()
  return rowToCase(rows[0])
}

async function listConfigs(Db: Orm, Kind: EvalConfigKind): Promise<EvalConfig[]> {
  const rows = await Db.select()
    .from(eval_configs)
    .where(eq(eval_configs.kind, Kind))
    .orderBy(asc(eval_configs.created_at), asc(eval_configs.id))
  return rows.map(rowToConfig)
}

async function getConfig(Db: Orm, Id: string): Promise<EvalConfig | null> {
  const rows = await Db.select().from(eval_configs).where(eq(eval_configs.id, Id)).limit(1)
  return rows[0] ? rowToConfig(rows[0]) : null
}

async function createConfig(Db: Orm, Data: { kind: EvalConfigKind; name: string; config: Record<string, unknown> }): Promise<EvalConfig> {
  const rows = await Db.insert(eval_configs)
    .values({ kind: Data.kind, name: Data.name, config: Data.config })
    .returning()
  return rowToConfig(rows[0])
}

async function updateConfig(Db: Orm, Id: string, Data: { name: string; config: Record<string, unknown> }): Promise<EvalConfig | null> {
  const rows = await Db.update(eval_configs)
    .set({ name: Data.name, config: Data.config, updated_at: sql`now()` })
    .where(eq(eval_configs.id, Id))
    .returning()
  return rows[0] ? rowToConfig(rows[0]) : null
}

async function deleteConfig(Db: Orm, Id: string): Promise<boolean> {
  const rows = await Db.delete(eval_configs).where(eq(eval_configs.id, Id)).returning({ id: eval_configs.id })
  return rows.length === 1
}

async function duplicateConfig(Db: Orm, Id: string): Promise<EvalConfig | null> {
  const SrcRows = await Db.select().from(eval_configs).where(eq(eval_configs.id, Id)).limit(1)
  const Src = SrcRows[0]
  if (!Src) return null
  const Name = await freeCopyName(Db, 'eval_configs', Src.name)
  const rows = await Db.insert(eval_configs)
    .values({ kind: Src.kind, name: Name, config: Src.config })
    .returning()
  return rowToConfig(rows[0])
}

async function freeCopyName(Db: SelectExecutor, Table: 'eval_datasets' | 'eval_configs', Base: string): Promise<string> {
  const Pattern = `${escapeLike(Base)} 副本%`
  const Rows = Table === 'eval_datasets'
    ? await Db.select({ name: eval_datasets.name })
      .from(eval_datasets)
      .where(or(eq(eval_datasets.name, Base), like(eval_datasets.name, Pattern)))
    : await Db.select({ name: eval_configs.name })
      .from(eval_configs)
      .where(or(eq(eval_configs.name, Base), like(eval_configs.name, Pattern)))
  const Taken = new Set<string>(Rows.map((Row) => Row.name))
  let N = 1
  while (Taken.has(N === 1 ? `${Base} 副本` : `${Base} 副本 ${N}`)) N += 1
  return N === 1 ? `${Base} 副本` : `${Base} 副本 ${N}`
}

function escapeLike(Value: string): string {
  return Value.replace(/[\\%_]/g, '\\$&')
}
