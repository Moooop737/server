/**
 * 测试数据物理清场 —— 只删本仓测试用的窄前缀与 --since 之后写入的行，正常数据不会命中。
 * 由 web 的 Vitest teardown 与 Playwright E2E fixture 以子进程调用（server 侧有 pg/ObjectStore，web 不引这些依赖）。
 * 顺序：traces（级联 stages）→ sessions（级联 messages）→ messages 兜底 → 资源/代码库/评测。
 * 用法：tsx --env-file=.env scripts/cleanup-test-data.ts --since 2026-10-30T06:00:00.000Z [--sessions-since ISO]
 */

import 'reflect-metadata'
import { container } from 'tsyringe'
import { createDbPool } from '../src/adapter/connection/pool'
import { ObjectStoreHandle } from '../src/adapter/contract'
import { parseDataUri } from '../src/adapter/storage/uri'
import { loadEnv } from '../test/load-env'

loadEnv()

const RESOURCE_PREFIXES = ['upload-queue-%', 'web-resources-%', 'web-resource-flow-%', 'e2e-ingest-%', 'retrieve-chain-%', '__eval_%']
const CODEBASE_PREFIXES = ['codebases-%', 'e2e-codebase-%']
const EVAL_PREFIXES = ['__eval_%', 'e2e-dataset-%', 'e2e-run-%', 'web-%']

const args = process.argv.slice(2)
const argOf = (Name: string): string | undefined => {
  const Index = args.indexOf(Name)
  return Index >= 0 ? args[Index + 1] : undefined
}
const Since = argOf('--since')
const SessionsSince = argOf('--sessions-since') ?? Since

void (async () => {
  const Store = container.resolve(ObjectStoreHandle)
  const Main = createDbPool(process.env.DATABASE_URL!)
  const Eval = process.env.EVAL_DATABASE_URL ? createDbPool(process.env.EVAL_DATABASE_URL) : Main
  const Report: Record<string, number> = {}

  if (Since !== undefined) {
    Report.traces = (await Main.query('DELETE FROM traces WHERE started_at >= $1', [Since])).rowCount ?? 0
    Report.messages = (await Main.query('DELETE FROM messages WHERE created_at >= $1', [Since])).rowCount ?? 0
  }
  if (SessionsSince !== undefined) {
    Report.sessions = (await Main.query('DELETE FROM sessions WHERE created_at >= $1', [SessionsSince])).rowCount ?? 0
  }

  const Resources = await Main.query<{ data_uri: string }>('SELECT data_uri FROM resources WHERE title LIKE ANY($1)', [RESOURCE_PREFIXES])
  for (const Row of Resources.rows) {
    const Parsed = parseDataUri(Row.data_uri)
    if ('key' in Parsed) await Store.delete(Parsed.key).catch(() => {})
  }
  Report.resources = (await Main.query('DELETE FROM resources WHERE title LIKE ANY($1)', [RESOURCE_PREFIXES])).rowCount ?? 0

  const Codebases = await Main.query<{ data_uri: string }>('SELECT data_uri FROM codebases WHERE title LIKE ANY($1)', [CODEBASE_PREFIXES])
  for (const Row of Codebases.rows) {
    const Parsed = parseDataUri(Row.data_uri)
    if ('key' in Parsed) await Store.delete(Parsed.key).catch(() => {})
  }
  Report.codebases = (await Main.query('DELETE FROM codebases WHERE title LIKE ANY($1)', [CODEBASE_PREFIXES])).rowCount ?? 0

  const Datasets = await Eval.query<{ id: string }>('SELECT id FROM eval_datasets WHERE name LIKE ANY($1)', [EVAL_PREFIXES])
  for (const Row of Datasets.rows) {
    await Eval.query('DELETE FROM eval_runs WHERE dataset_id = $1', [Row.id])
    await Eval.query('DELETE FROM eval_cases WHERE dataset_id = $1', [Row.id])
  }
  Report.datasets = (await Eval.query('DELETE FROM eval_datasets WHERE name LIKE ANY($1)', [EVAL_PREFIXES])).rowCount ?? 0
  Report.configs = (await Eval.query('DELETE FROM eval_configs WHERE name LIKE ANY($1)', [EVAL_PREFIXES])).rowCount ?? 0

  console.log(JSON.stringify(Report))

  if (Eval !== Main) await Eval.end()
  await Main.end()
})().catch((Err) => {
  console.error(Err)
  process.exit(1)
})
