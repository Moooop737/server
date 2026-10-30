/**
 * 评测题集与配置行 —— eval_datasets / eval_cases / eval_configs 的读/写；eval_runs 只做计数。
 * 三张表住「选中的库」：共享模式是主库，隔离模式是评测库；调用方一律经 EvalAssembly.repo。
 * config 是 jsonb 文档，本层不窄化也不校验（模型在册、数值范围归 routes/eval.ts）。
 * gold 是 [{ data_uri, chunk_index, content_prefix }]；负例必须为空数组（DB CHECK 兜底）。
 * 数据集删除不级联 runs：有 run 时 eval_runs.dataset_id 的 RESTRICT 会拒绝；本层先给计数，由路由决定怎么回。
 * 复制（数据集 / 配置）只改 id 与 name，不动原件；名字自动找空位（xxx 副本 / xxx 副本 2）。
 */

export {
  listDatasets, getDataset, createDataset, updateDataset, setDatasetBaseline, countRunsOfDataset, deleteDataset, duplicateDataset,
  listCases, getCase, createCase, updateCase, deleteCase, nextCaseKey, upsertCase,
  listConfigs, getConfig, createConfig, updateConfig, deleteConfig, duplicateConfig,
}
export type { EvalDataset, EvalCase, EvalGold, EvalAssertion, EvalAssertions, EvalConfig, EvalConfigKind, EvalCaseInput }

import { logError } from '../../trace/systemtrace/log'
import type { Pool, PoolClient } from 'pg'

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

const DATASET_SELECT = `
  SELECT d.*, (SELECT COUNT(*)::int FROM eval_cases c WHERE c.dataset_id = d.id) AS case_count
    FROM eval_datasets d`

async function listDatasets(Db: Pool): Promise<EvalDataset[]> {
  const { rows } = await Db.query(`${DATASET_SELECT} ORDER BY d.created_at ASC, d.id ASC`)
  return rows.map(rowToDataset)
}

async function getDataset(Db: Pool, Id: string): Promise<EvalDataset | null> {
  const { rows } = await Db.query(`${DATASET_SELECT} WHERE d.id = $1`, [Id])
  return rows[0] ? rowToDataset(rows[0]) : null
}

async function createDataset(Db: Pool, Data: { name: string; note: string }): Promise<EvalDataset> {
  const { rows } = await Db.query(
    `INSERT INTO eval_datasets (name, note) VALUES ($1, $2) RETURNING *`,
    [Data.name, Data.note],
  )
  return rowToDataset(rows[0])
}

async function updateDataset(Db: Pool, Id: string, Data: { name: string; note: string }): Promise<EvalDataset | null> {
  const { rows } = await Db.query(
    `UPDATE eval_datasets SET name = $2, note = $3, updated_at = now() WHERE id = $1 RETURNING *`,
    [Id, Data.name, Data.note],
  )
  return rows[0] ? { ...rowToDataset(rows[0]), case_count: await caseCount(Db, Id) } : null
}

async function setDatasetBaseline(Db: Pool, Id: string, RunId: string): Promise<EvalDataset | null> {
  const { rows } = await Db.query(
    `UPDATE eval_datasets SET baseline_run_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [Id, RunId],
  )
  return rows[0] ? { ...rowToDataset(rows[0]), case_count: await caseCount(Db, Id) } : null
}

async function caseCount(Db: Pool, DatasetId: string): Promise<number> {
  const { rows } = await Db.query(`SELECT COUNT(*)::int AS n FROM eval_cases WHERE dataset_id = $1`, [DatasetId])
  return Number(rows[0]?.n ?? 0)
}

async function countRunsOfDataset(Db: Pool, DatasetId: string): Promise<number> {
  const { rows } = await Db.query(`SELECT COUNT(*)::int AS n FROM eval_runs WHERE dataset_id = $1`, [DatasetId])
  return Number(rows[0]?.n ?? 0)
}

async function deleteDataset(Db: Pool, Id: string): Promise<boolean> {
  const { rowCount } = await Db.query(`DELETE FROM eval_datasets WHERE id = $1`, [Id])
  return rowCount === 1
}

async function duplicateDataset(Db: Pool, Id: string): Promise<EvalDataset | null> {
  const client = await Db.connect()
  try {
    await client.query('BEGIN')
    const { rows: [src] } = await client.query(`SELECT * FROM eval_datasets WHERE id = $1`, [Id])
    if (!src) {
      await client.query('ROLLBACK')
      return null
    }
    const Name = await freeCopyName(client, 'eval_datasets', src.name)
    const { rows: [copy] } = await client.query(
      `INSERT INTO eval_datasets (name, note) VALUES ($1, $2) RETURNING *`,
      [Name, src.note],
    )
    const { rowCount } = await client.query(
      `INSERT INTO eval_cases (dataset_id, case_key, level, query, negative, note, gold, assertions)
       SELECT $1, case_key, level, query, negative, note, gold, assertions FROM eval_cases WHERE dataset_id = $2`,
      [copy.id, Id],
    )
    await client.query('COMMIT')
    return { ...rowToDataset(copy), case_count: rowCount ?? 0 }
  } catch (err) {
    await client.query('ROLLBACK').catch((rbErr) => logError('E_ROLLBACK', String(rbErr)))
    throw err
  } finally {
    client.release()
  }
}

async function listCases(Db: Pool, DatasetId: string): Promise<EvalCase[]> {
  const { rows } = await Db.query(
    `SELECT * FROM eval_cases WHERE dataset_id = $1 ORDER BY case_key ASC, id ASC`,
    [DatasetId],
  )
  return rows.map(rowToCase)
}

async function getCase(Db: Pool, Id: string): Promise<EvalCase | null> {
  const { rows } = await Db.query(`SELECT * FROM eval_cases WHERE id = $1`, [Id])
  return rows[0] ? rowToCase(rows[0]) : null
}

async function nextCaseKey(Db: Pool, DatasetId: string, Level: string): Promise<string> {
  const { rows } = await Db.query(
    `SELECT case_key FROM eval_cases WHERE dataset_id = $1 AND level = $2`,
    [DatasetId, Level],
  )
  const Taken = new Set<string>(rows.map((r) => r.case_key as string))
  let N = 1
  while (Taken.has(`${Level}-N${N}`)) N += 1
  return `${Level}-N${N}`
}

async function createCase(Db: Pool, DatasetId: string, Data: EvalCaseInput): Promise<EvalCase> {
  const Key = Data.case_key ?? await nextCaseKey(Db, DatasetId, Data.level)
  const { rows } = await Db.query(
    `INSERT INTO eval_cases (dataset_id, case_key, level, query, negative, note, gold, assertions)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
     RETURNING *`,
    [DatasetId, Key, Data.level, Data.query, Data.negative, Data.note, JSON.stringify(Data.gold), JSON.stringify(Data.assertions ?? emptyAssertions())],
  )
  return rowToCase(rows[0])
}

async function updateCase(Db: Pool, Id: string, Data: Omit<EvalCaseInput, 'case_key'>): Promise<EvalCase | null> {
  const { rows } = await Db.query(
    `UPDATE eval_cases
        SET level = $2, query = $3, negative = $4, note = $5, gold = $6::jsonb, assertions = $7::jsonb, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [Id, Data.level, Data.query, Data.negative, Data.note, JSON.stringify(Data.gold), JSON.stringify(Data.assertions ?? emptyAssertions())],
  )
  return rows[0] ? rowToCase(rows[0]) : null
}

async function deleteCase(Db: Pool, Id: string): Promise<boolean> {
  const { rowCount } = await Db.query(`DELETE FROM eval_cases WHERE id = $1`, [Id])
  return rowCount === 1
}

async function upsertCase(Db: Pool, DatasetId: string, Data: EvalCaseInput & { case_key: string }): Promise<EvalCase> {
  const AssertionClause = Data.assertions === undefined ? 'assertions = eval_cases.assertions' : 'assertions = excluded.assertions'
  const { rows } = await Db.query(
    `INSERT INTO eval_cases (dataset_id, case_key, level, query, negative, note, gold, assertions)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
     ON CONFLICT (dataset_id, case_key)
     DO UPDATE SET level = excluded.level, query = excluded.query, negative = excluded.negative,
                   note = excluded.note, gold = excluded.gold, ${AssertionClause}, updated_at = now()
     RETURNING *`,
    [DatasetId, Data.case_key, Data.level, Data.query, Data.negative, Data.note, JSON.stringify(Data.gold), JSON.stringify(Data.assertions ?? emptyAssertions())],
  )
  return rowToCase(rows[0])
}

async function listConfigs(Db: Pool, Kind: EvalConfigKind): Promise<EvalConfig[]> {
  const { rows } = await Db.query(
    `SELECT * FROM eval_configs WHERE kind = $1 ORDER BY created_at ASC, id ASC`,
    [Kind],
  )
  return rows.map(rowToConfig)
}

async function getConfig(Db: Pool, Id: string): Promise<EvalConfig | null> {
  const { rows } = await Db.query(`SELECT * FROM eval_configs WHERE id = $1`, [Id])
  return rows[0] ? rowToConfig(rows[0]) : null
}

async function createConfig(Db: Pool, Data: { kind: EvalConfigKind; name: string; config: Record<string, unknown> }): Promise<EvalConfig> {
  const { rows } = await Db.query(
    `INSERT INTO eval_configs (kind, name, config) VALUES ($1, $2, $3::jsonb) RETURNING *`,
    [Data.kind, Data.name, JSON.stringify(Data.config)],
  )
  return rowToConfig(rows[0])
}

async function updateConfig(Db: Pool, Id: string, Data: { name: string; config: Record<string, unknown> }): Promise<EvalConfig | null> {
  const { rows } = await Db.query(
    `UPDATE eval_configs SET name = $2, config = $3::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
    [Id, Data.name, JSON.stringify(Data.config)],
  )
  return rows[0] ? rowToConfig(rows[0]) : null
}

async function deleteConfig(Db: Pool, Id: string): Promise<boolean> {
  const { rowCount } = await Db.query(`DELETE FROM eval_configs WHERE id = $1`, [Id])
  return rowCount === 1
}

async function duplicateConfig(Db: Pool, Id: string): Promise<EvalConfig | null> {
  const { rows: [src] } = await Db.query(`SELECT * FROM eval_configs WHERE id = $1`, [Id])
  if (!src) return null
  const Name = await freeCopyName(Db, 'eval_configs', src.name)
  const { rows } = await Db.query(
    `INSERT INTO eval_configs (kind, name, config) VALUES ($1, $2, $3::jsonb) RETURNING *`,
    [src.kind, Name, JSON.stringify(src.config)],
  )
  return rowToConfig(rows[0])
}

async function freeCopyName(Db: Pool | PoolClient, Table: 'eval_datasets' | 'eval_configs', Base: string): Promise<string> {
  const { rows } = await Db.query(`SELECT name FROM ${Table} WHERE name = $1 OR name LIKE $2`, [Base, `${Base} 副本%`])
  const Taken = new Set<string>(rows.map((r) => r.name as string))
  let N = 1
  while (Taken.has(N === 1 ? `${Base} 副本` : `${Base} 副本 ${N}`)) N += 1
  return N === 1 ? `${Base} 副本` : `${Base} 副本 ${N}`
}
