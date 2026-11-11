/**
 * 评测运行行 —— eval_runs 的读/写：建 run（冻快照）、逐条追加结果、状态流转、取消/删除、启动清扫。
 * 一行 run 自带完整历史：snapshot 是输入（题集逐条 + 两份配置 + embedding + 语料），results 是输出（逐条数字）。
 * results 用 jsonb 数组追加（`||`），不建明细表；聚合与 7.3 对照都在读取时算。
 * 删除只接结束态（由路由判定）；删行同时清掉数据集的 baseline_run_id，避免悬空。
 * getChunkByDataUri 供 gold 失效校验：按资源 data_uri + 块号取未删块，前缀比对由调用方做；它 join chunks，保留裸 SQL。
 * 其余全部走 Drizzle；时间戳经 sql`now()` 由数据库时钟写。
 */

export {
  createRun, getRun, listRuns, appendRunResult, setHumanResult, startRun, finishRun, cancelQueuedRun,
  markInterruptedRuns, deleteRun, getChunkByDataUri,
}
export type { EvalRun, EvalRunStatus, EvalRunSnapshot, EvalRunCaseSnapshot, EvalRunResult, EvalHumanResult, EvalVerdict, EvalAssertionCheck, EvalAssertionResult, EvalJudgeResult, EvalCitation }

import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { rowToChunk } from './chunk'
import { eval_datasets, eval_runs } from './orm/schema'
import type { Pool } from 'pg'
import type { Orm } from './orm/client'
import type { Chunk } from './chunk'
import type { EvalGold, EvalAssertions } from './eval'
import type { PipelineNode } from '../../retrieve/pipeline/pipeline'
import type { ResourceCounts } from './resource'

type EvalRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

interface EvalRunCaseSnapshot {
  case_key: string
  level: string
  query: string
  negative: boolean
  note: string
  gold: EvalGold[]
  assertions: EvalAssertions
}

interface EvalRunSnapshot {
  dataset: { id: string; name: string; note: string }
  cases: EvalRunCaseSnapshot[]
  run_config: { id: string; name: string; config: Record<string, unknown> }
  metric_config: { id: string; name: string; config: Record<string, unknown> }
  rubric?: { version: string; text: string } | null
  mode?: 'retrieval' | 'answer'
  embedding: { model: string; dimensions: number }
  corpus: ResourceCounts
  /* 创建 run 时冻结的检索管线；旧 run 没有该字段，执行器拒绝跑（历史只展示） */
  pipeline?: { version: number; nodes: PipelineNode[]; output: string | null }
}

type EvalVerdict = 'pass' | 'fail' | 'unscored'

interface EvalAssertionCheck {
  text: string
  regex: boolean
  matched: boolean
  error: string | null
}

interface EvalAssertionResult {
  passed: boolean
  expect: EvalAssertionCheck[]
  reject: EvalAssertionCheck[]
}

interface EvalJudgeResult {
  groundedness: number | null
  correctness: number | null
  citation: number | null
  verdict: 'pass' | 'fail' | null
  reason: string
  error: string | null
}

interface EvalCitation {
  index: number
  chunkId: string
  dataUri: string
  chunkIndex: number
  docTitle: string
  source: string | null
  content: string
}

interface EvalRunResult {
  case_key: string
  negative: boolean
  rank: number | null
  matched: number
  total: number
  hit_count: number
  recall: number
  mrr: number
  missing_gold: number
  duration_ms: number
  error: string | null
  answer?: string | null
  citations?: EvalCitation[]
  assertion?: EvalAssertionResult | null
  judge?: EvalJudgeResult | null
  verdict?: EvalVerdict | null
}

interface EvalHumanResult {
  case_key: string
  verdict: 'pass' | 'fail'
  groundedness: number | null
  correctness: number | null
  citation: number | null
  note: string
  updated_at: string
}

interface EvalRun {
  id: string
  dataset_id: string
  run_config_id: string | null
  metric_config_id: string | null
  status: EvalRunStatus
  snapshot: EvalRunSnapshot
  results: EvalRunResult[]
  human_results: EvalHumanResult[]
  started_at: string | null
  ended_at: string | null
  duration_ms: number | null
  error_reason: string | null
  created_at: string
}

function iso(v: Date | null): string | null {
  return v === null ? null : v.toISOString()
}

function rowToRun(r: any): EvalRun {
  return {
    id: r.id,
    dataset_id: r.dataset_id,
    run_config_id: r.run_config_id ?? null,
    metric_config_id: r.metric_config_id ?? null,
    status: r.status,
    snapshot: r.snapshot !== null && typeof r.snapshot === 'object' && !Array.isArray(r.snapshot) ? (r.snapshot as EvalRunSnapshot) : ({} as EvalRunSnapshot),
    results: Array.isArray(r.results) ? (r.results as EvalRunResult[]) : [],
    human_results: Array.isArray(r.human_results) ? (r.human_results as EvalHumanResult[]) : [],
    started_at: iso(r.started_at),
    ended_at: iso(r.ended_at),
    duration_ms: r.duration_ms == null ? null : Number(r.duration_ms),
    error_reason: r.error_reason ?? null,
    created_at: iso(r.created_at)!,
  }
}

async function createRun(
  Db: Orm,
  Data: { dataset_id: string; run_config_id: string; metric_config_id: string; snapshot: EvalRunSnapshot },
): Promise<EvalRun> {
  const rows = await Db.insert(eval_runs).values({
    dataset_id: Data.dataset_id,
    run_config_id: Data.run_config_id,
    metric_config_id: Data.metric_config_id,
    snapshot: Data.snapshot,
  }).returning()
  return rowToRun(rows[0])
}

async function getRun(Db: Orm, Id: string): Promise<EvalRun | null> {
  const rows = await Db.select().from(eval_runs).where(eq(eval_runs.id, Id)).limit(1)
  return rows[0] ? rowToRun(rows[0]) : null
}

async function listRuns(Db: Orm, DatasetId: string | null, RunConfigId: string | null = null): Promise<EvalRun[]> {
  const rows = await Db.select()
    .from(eval_runs)
    .where(and(
      DatasetId === null ? undefined : eq(eval_runs.dataset_id, DatasetId),
      RunConfigId === null ? undefined : eq(eval_runs.run_config_id, RunConfigId),
    ))
    .orderBy(desc(eval_runs.created_at), desc(eval_runs.id))
  return rows.map(rowToRun)
}

async function appendRunResult(Db: Orm, Id: string, Result: EvalRunResult): Promise<boolean> {
  const rows = await Db.update(eval_runs)
    .set({ results: sql`${eval_runs.results} || ${JSON.stringify([Result])}::jsonb` })
    .where(eq(eval_runs.id, Id))
    .returning({ id: eval_runs.id })
  return rows.length === 1
}

async function setHumanResult(Db: Orm, RunId: string, Entry: EvalHumanResult): Promise<EvalHumanResult[] | null> {
  return Db.transaction(async (Tx) => {
    const rows = await Tx.select({ human_results: eval_runs.human_results })
      .from(eval_runs)
      .where(eq(eval_runs.id, RunId))
      .for('update')
    if (!rows[0]) return null
    const Existing = Array.isArray(rows[0].human_results) ? (rows[0].human_results as EvalHumanResult[]) : []
    const Next = [...Existing.filter((Item) => Item.case_key !== Entry.case_key), Entry]
    await Tx.update(eval_runs).set({ human_results: Next }).where(eq(eval_runs.id, RunId))
    return Next
  })
}

async function startRun(Db: Orm, Id: string): Promise<boolean> {
  const rows = await Db.update(eval_runs)
    .set({ status: 'running', started_at: sql`coalesce(${eval_runs.started_at}, now())` })
    .where(and(eq(eval_runs.id, Id), eq(eval_runs.status, 'queued')))
    .returning({ id: eval_runs.id })
  return rows.length === 1
}

async function finishRun(
  Db: Orm,
  Id: string,
  Status: 'done' | 'failed' | 'cancelled',
  Data: { duration_ms: number; error_reason?: string | null },
): Promise<boolean> {
  const rows = await Db.update(eval_runs)
    .set({
      status: Status,
      ended_at: sql`now()`,
      duration_ms: Data.duration_ms,
      error_reason: Data.error_reason ?? null,
    })
    .where(eq(eval_runs.id, Id))
    .returning({ id: eval_runs.id })
  return rows.length === 1
}

async function cancelQueuedRun(Db: Orm, Id: string): Promise<boolean> {
  const rows = await Db.update(eval_runs)
    .set({ status: 'cancelled', ended_at: sql`now()`, error_reason: '已取消' })
    .where(and(eq(eval_runs.id, Id), eq(eval_runs.status, 'queued')))
    .returning({ id: eval_runs.id })
  return rows.length === 1
}

async function markInterruptedRuns(Db: Orm): Promise<number> {
  const rows = await Db.update(eval_runs)
    .set({ status: 'cancelled', ended_at: sql`now()`, error_reason: '进程重启' })
    .where(inArray(eval_runs.status, ['queued', 'running']))
    .returning({ id: eval_runs.id })
  return rows.length
}

async function deleteRun(Db: Orm, Id: string): Promise<boolean> {
  return Db.transaction(async (Tx) => {
    await Tx.update(eval_datasets)
      .set({ baseline_run_id: null, updated_at: sql`now()` })
      .where(eq(eval_datasets.baseline_run_id, Id))
    const rows = await Tx.delete(eval_runs).where(eq(eval_runs.id, Id)).returning({ id: eval_runs.id })
    return rows.length === 1
  })
}

async function getChunkByDataUri(Db: Pool, Uri: string, ChunkIndex: number): Promise<Chunk | null> {
  const { rows } = await Db.query(
    `SELECT c.* FROM chunks c
       JOIN resources r ON r.id = c.resource_id
      WHERE r.data_uri = $1 AND c.chunk_index = $2
        AND r.deleted_at IS NULL AND c.deleted_at IS NULL
      LIMIT 1`,
    [Uri, ChunkIndex],
  )
  return rows[0] ? rowToChunk(rows[0]) : null
}
