/**
 * 评测运行行 —— eval_runs 的读/写：建 run（冻快照）、逐条追加结果、状态流转、取消/删除、启动清扫。
 * 一行 run 自带完整历史：snapshot 是输入（题集逐条 + 两份配置 + embedding + 语料），results 是输出（逐条数字）。
 * results 用 jsonb 数组追加（`||`），不建明细表；聚合与 7.3 对照都在读取时算。
 * 删除只接结束态（由路由判定）；删行同时清掉数据集的 baseline_run_id，避免悬空。
 * getChunkByDataUri 供 gold 失效校验：按资源 data_uri + 块号取未删块，前缀比对由调用方做。
 */

export {
  createRun, getRun, listRuns, appendRunResult, setHumanResult, startRun, finishRun, cancelQueuedRun,
  markInterruptedRuns, deleteRun, getChunkByDataUri,
}
export type { EvalRun, EvalRunStatus, EvalRunSnapshot, EvalRunCaseSnapshot, EvalRunResult, EvalHumanResult, EvalVerdict, EvalAssertionCheck, EvalAssertionResult, EvalJudgeResult, EvalCitation }

import { rowToChunk } from './chunk'
import { logError } from '../../trace/systemtrace/log'

import type { Pool } from 'pg'
import type { Chunk } from './chunk'
import type { EvalGold, EvalAssertions } from './eval'
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
  embedding: { model: string; dimensions: number }
  corpus: ResourceCounts
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
  Db: Pool,
  Data: { dataset_id: string; run_config_id: string; metric_config_id: string; snapshot: EvalRunSnapshot },
): Promise<EvalRun> {
  const { rows } = await Db.query(
    `INSERT INTO eval_runs (dataset_id, run_config_id, metric_config_id, snapshot)
       VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [Data.dataset_id, Data.run_config_id, Data.metric_config_id, JSON.stringify(Data.snapshot)],
  )
  return rowToRun(rows[0])
}

async function getRun(Db: Pool, Id: string): Promise<EvalRun | null> {
  const { rows } = await Db.query(`SELECT * FROM eval_runs WHERE id = $1`, [Id])
  return rows[0] ? rowToRun(rows[0]) : null
}

async function listRuns(Db: Pool, DatasetId: string | null, RunConfigId: string | null = null): Promise<EvalRun[]> {
  const { rows } = await Db.query(
    `SELECT * FROM eval_runs
      WHERE ($1::uuid IS NULL OR dataset_id = $1)
        AND ($2::uuid IS NULL OR run_config_id = $2)
      ORDER BY created_at DESC, id DESC`,
    [DatasetId, RunConfigId],
  )
  return rows.map(rowToRun)
}

async function appendRunResult(Db: Pool, Id: string, Result: EvalRunResult): Promise<boolean> {
  const { rowCount } = await Db.query(
    `UPDATE eval_runs SET results = results || $2::jsonb WHERE id = $1`,
    [Id, JSON.stringify([Result])],
  )
  return rowCount === 1
}

async function setHumanResult(Db: Pool, RunId: string, Entry: EvalHumanResult): Promise<EvalHumanResult[] | null> {
  const client = await Db.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(`SELECT human_results FROM eval_runs WHERE id = $1 FOR UPDATE`, [RunId])
    if (!rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    const Existing = Array.isArray(rows[0].human_results) ? (rows[0].human_results as EvalHumanResult[]) : []
    const Next = [...Existing.filter((Item) => Item.case_key !== Entry.case_key), Entry]
    await client.query(`UPDATE eval_runs SET human_results = $2::jsonb WHERE id = $1`, [RunId, JSON.stringify(Next)])
    await client.query('COMMIT')
    return Next
  } catch (err) {
    await client.query('ROLLBACK').catch((rbErr) => logError('E_ROLLBACK', String(rbErr)))
    throw err
  } finally {
    client.release()
  }
}

async function startRun(Db: Pool, Id: string): Promise<boolean> {
  const { rowCount } = await Db.query(
    `UPDATE eval_runs
        SET status = 'running', started_at = COALESCE(started_at, now())
      WHERE id = $1 AND status = 'queued'`,
    [Id],
  )
  return rowCount === 1
}

async function finishRun(
  Db: Pool,
  Id: string,
  Status: 'done' | 'failed' | 'cancelled',
  Data: { duration_ms: number; error_reason?: string | null },
): Promise<boolean> {
  const { rowCount } = await Db.query(
    `UPDATE eval_runs
        SET status = $2, ended_at = now(), duration_ms = $3, error_reason = $4
      WHERE id = $1`,
    [Id, Status, Data.duration_ms, Data.error_reason ?? null],
  )
  return rowCount === 1
}

async function cancelQueuedRun(Db: Pool, Id: string): Promise<boolean> {
  const { rowCount } = await Db.query(
    `UPDATE eval_runs
        SET status = 'cancelled', ended_at = now(), error_reason = '已取消'
      WHERE id = $1 AND status = 'queued'`,
    [Id],
  )
  return rowCount === 1
}

async function markInterruptedRuns(Db: Pool): Promise<number> {
  const { rowCount } = await Db.query(
    `UPDATE eval_runs
        SET status = 'cancelled', ended_at = now(), error_reason = '进程重启'
      WHERE status IN ('queued', 'running')`,
  )
  return rowCount ?? 0
}

async function deleteRun(Db: Pool, Id: string): Promise<boolean> {
  const client = await Db.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE eval_datasets SET baseline_run_id = NULL, updated_at = now() WHERE baseline_run_id = $1`,
      [Id],
    )
    const { rowCount } = await client.query(`DELETE FROM eval_runs WHERE id = $1`, [Id])
    await client.query('COMMIT')
    return rowCount === 1
  } catch (err) {
    await client.query('ROLLBACK').catch((rbErr) => logError('E_ROLLBACK', String(rbErr)))
    throw err
  } finally {
    client.release()
  }
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
