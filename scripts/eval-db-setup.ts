/**
 * 评测库建库与迁移 —— 隔离模式的第一次准备。
 * 读 EVAL_DATABASE_URL，缺库时连同一实例的 postgres 库建库，再用 dbmate 跑同一套迁移（--no-dump-schema）。
 * 连接串只走环境变量：不打印、不放进 argv（dbmate 用 env 覆盖 .env，已实测）。
 * 重复执行幂等：库存在就跳过创建，dbmate up 只补未应用的迁移。
 */

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = resolve(SCRIPT_DIR, '..')

async function main(): Promise<void> {
  const EvalUrl = required('EVAL_DATABASE_URL')
  const DbName = databaseName(EvalUrl)
  if (DbName === 'postgres') throw new Error('评测库不能指向维护库 postgres')
  const MaintenanceUrl = new URL(EvalUrl)
  MaintenanceUrl.pathname = '/postgres'

  await ensureDatabase(MaintenanceUrl.toString(), DbName)
  runMigrations(EvalUrl)
  const Applied = await migrationCount(EvalUrl)
  console.log(`I_EVAL_DB_READY db=${DbName} applied=${Applied}`)
}

async function ensureDatabase(MaintenanceUrl: string, DbName: string): Promise<void> {
  const Db = new Client({ connectionString: MaintenanceUrl })
  await Db.connect()
  try {
    const { rowCount } = await Db.query('select 1 from pg_database where datname = $1', [DbName])
    if (rowCount && rowCount > 0) {
      console.log(`I_EVAL_DB_EXISTS db=${DbName}`)
      return
    }
    await Db.query(`CREATE DATABASE "${DbName}"`)
    console.log(`I_EVAL_DB_CREATED db=${DbName}`)
  } finally {
    await Db.end()
  }
}

function runMigrations(EvalUrl: string): void {
  const Res = spawnSync('dbmate', ['--no-dump-schema', 'up'], {
    cwd: SERVER_ROOT,
    env: { ...process.env, DATABASE_URL: EvalUrl },
    stdio: 'inherit',
  })
  if (Res.error) throw Res.error
  if (Res.status !== 0) throw new Error(`dbmate 退出码 ${Res.status}`)
}

async function migrationCount(EvalUrl: string): Promise<number> {
  const Db = new Client({ connectionString: EvalUrl })
  await Db.connect()
  try {
    const { rows } = await Db.query<{ n: number }>('select count(*)::int as n from schema_migrations')
    return rows[0]?.n ?? 0
  } finally {
    await Db.end()
  }
}

function databaseName(EvalUrl: string): string {
  let Parsed: URL
  try {
    Parsed = new URL(EvalUrl)
  } catch {
    throw new Error('EVAL_DATABASE_URL 不是合法 URL')
  }
  if (Parsed.protocol !== 'postgres:' && Parsed.protocol !== 'postgresql:') {
    throw new Error('EVAL_DATABASE_URL 必须是 postgres/postgresql')
  }
  const Name = decodeURIComponent(Parsed.pathname.replace(/^\/+|\/+$/g, ''))
  if (!/^[a-z_][a-z0-9_]*$/.test(Name)) {
    throw new Error(`评测库名不合法: ${Name}`)
  }
  return Name
}

function required(Name: string): string {
  const Value = process.env[Name]?.trim()
  if (!Value) throw new Error(`缺少 ${Name}；隔离模式要先配它，共享模式不需要跑本脚本`)
  return Value
}

main().then(
  () => process.exit(0),
  (Err: unknown) => {
    console.error(`\neval-db-setup 失败: ${Err instanceof Error ? Err.message : String(Err)}`)
    process.exit(1)
  },
)
