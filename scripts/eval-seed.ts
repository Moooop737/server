/**
 * 隔离模式语料灌入 —— 把主库 ready 资源按份复制进评测库，走现有 ingest 链路重灌。
 * 对象复制到评测库自己的 key（eval/<content_hash>/<原 key>），不共享主库对象；主库 purge 不影响评测。
 * 幂等：按 content_hash 查评测库已有行；ready 跳过，软删恢复，其余状态重新 ingest。
 * 跑法：EVAL_DATABASE_URL=... npm run eval:seed；共享模式（未配 URL）直接退出 0。
 */

import 'reflect-metadata'
import { Client } from 'pg'
import { container } from 'tsyringe'
import { AppConfig } from '../src/config'
import { EvalAssembly } from '../src/eval/assembly'
import { ObjectStoreHandle } from '../src/adapter/contract'
import { RuntimeModelRegistry } from '../src/adapter/model/runtime-registry'
import { IngestFactory } from '../src/ingest/ingest'
import { ResourceIngest } from '../src/resource/ingest'
import { buildDataUri, parseDataUri } from '../src/adapter/storage/uri'
import { sha256Hex } from '../src/adapter/storage/hash'

import type { ObjectStore, Repo } from '../src/adapter/contract'

interface MainRow {
  id: string
  title: string
  source: string | null
  data_uri: string
  content_type: string
  content_hash: string | null
}

interface SeedContext {
  EvalRepo: Repo
  Store: ObjectStore
  Ingest: ResourceIngest
}

interface SeedOutcome {
  outcome: 'seeded' | 'skipped' | 'failed'
  detail?: string
}

interface SeedArgs {
  limit: number | null
}

async function main(): Promise<void> {
  const Args = parseArgs(process.argv.slice(2))
  const Config = container.resolve(AppConfig)
  if (!Config.evalDatabaseUrl) {
    console.log('eval-seed: 未设置 EVAL_DATABASE_URL（共享模式直接用主库语料），无需灌入')
    return
  }

  const Assembly = container.resolve(EvalAssembly)
  if (Assembly.mode !== 'isolated') throw new Error('评测世界不是隔离模式')
  const Ctx: SeedContext = {
    EvalRepo: Assembly.repo,
    Store: container.resolve(ObjectStoreHandle),
    Ingest: new ResourceIngest(
      Config,
      container.resolve(ObjectStoreHandle),
      Assembly.repo,
      container.resolve(IngestFactory),
      container.resolve(RuntimeModelRegistry),
    ),
  }

  const Cleaned = await Ctx.EvalRepo.markStaleOnBoot()
  if (Cleaned.resources > 0 || Cleaned.uploads > 0) {
    console.log(`I_EVAL_SEED_CLEANUP processing→process_failed=${Cleaned.resources} uploading→upload_failed=${Cleaned.uploads}`)
  }

  const Rows = await mainReadyRows()
  const Selected = Args.limit === null ? Rows : Rows.slice(0, Args.limit)
  console.log(`I_EVAL_SEED_START resources=${Selected.length}/${Rows.length}`)
  const Stats = { seeded: 0, skipped: 0, failed: 0 }

  for (const [Index, Row] of Selected.entries()) {
    const Label = `[${Index + 1}/${Selected.length}] ${shortTitle(Row.title)} (${Row.id})`
    try {
      const Result = await seedOne(Row, Ctx)
      Stats[Result.outcome] += 1
      console.log(`${Label} ${Result.outcome}${Result.detail ? ` ${Result.detail}` : ''}`)
    } catch (Err) {
      Stats.failed += 1
      console.log(`${Label} failed ${Err instanceof Error ? Err.message : String(Err)}`)
    }
  }

  console.log(`I_EVAL_SEED_DONE seeded=${Stats.seeded} skipped=${Stats.skipped} failed=${Stats.failed}`)
  if (Stats.failed > 0) process.exitCode = 1
}

async function seedOne(Row: MainRow, Ctx: SeedContext): Promise<SeedOutcome> {
  const MainParts = parseDataUri(Row.data_uri)
  const Source = await readObject(Ctx.Store, MainParts.key)
  if (!Source) return { outcome: 'failed', detail: '主库对象不存在' }

  const Hash = sha256Hex(Source.bytes)
  if (Row.content_hash !== null && Row.content_hash !== Hash) {
    console.log(`W_EVAL_SEED_HASH ${Row.id} 主库 hash 与现读字节不一致，按现读字节写评测库`)
  }

  const Existing = await Ctx.EvalRepo.getResourceByContentHash(Hash)
  if (Existing && Existing.deleted_at === null && Existing.status === 'ready') {
    return { outcome: 'skipped' }
  }

  let TargetDataUri: string
  let TargetId: string
  if (Existing) {
    TargetDataUri = Existing.data_uri
    TargetId = Existing.id
    if (Existing.deleted_at !== null) {
      const Restored = await Ctx.EvalRepo.restoreResource(Existing.id)
      if (!Restored) return { outcome: 'failed', detail: '软删行恢复失败' }
    }
  } else {
    TargetDataUri = buildDataUri(MainParts.bucket, `eval/${Hash}/${MainParts.key}`)
    const Created = await Ctx.EvalRepo.createResource({
      title: Row.title,
      source: Row.source,
      data_uri: TargetDataUri,
      content_type: Row.content_type,
      status: 'uploaded',
      storage_size_bytes: Source.bytes.length,
      content_hash: Hash,
    })
    TargetId = Created.id
  }

  const TargetParts = parseDataUri(TargetDataUri)
  await Ctx.Store.put(TargetParts.key, Source.bytes, Row.content_type)

  const Result = await Ctx.Ingest.ingest(TargetId, undefined)
  if (Result.resource?.status === 'ready') {
    return { outcome: 'seeded', detail: `chunks=${Result.chunkCount}` }
  }
  return {
    outcome: 'failed',
    detail: Result.failure?.code ?? Result.resource?.error_reason ?? 'ingest 未 ready',
  }
}

async function mainReadyRows(): Promise<MainRow[]> {
  const Url = process.env.DATABASE_URL?.trim()
  if (!Url) throw new Error('缺少 DATABASE_URL')
  const Db = new Client({ connectionString: Url })
  await Db.connect()
  try {
    const { rows } = await Db.query<MainRow>(
      `select id, title, source, data_uri, content_type, content_hash
         from resources
        where status = 'ready' and deleted_at is null
        order by created_at asc`,
    )
    return rows
  } finally {
    await Db.end()
  }
}

async function readObject(Store: ObjectStore, Key: string): Promise<{ bytes: Buffer } | null> {
  const Body = await Store.get(Key)
  if (!Body) return null
  const Chunks: Buffer[] = []
  for await (const Chunk of Body.body) {
    Chunks.push(Buffer.isBuffer(Chunk) ? Chunk : Buffer.from(Chunk as Uint8Array))
  }
  return { bytes: Buffer.concat(Chunks) }
}

function shortTitle(Title: string): string {
  return Title.length <= 40 ? Title : `${Title.slice(0, 39)}…`
}

function parseArgs(Argv: string[]): SeedArgs {
  let Limit: number | null = null
  for (let i = 0; i < Argv.length; i++) {
    const Key = Argv[i]
    if (Key === '--help' || Key === '-h') {
      console.log('用法: npm run eval:seed -- [--limit <n>]')
      process.exit(0)
    }
    if (Key !== '--limit') throw new Error(`未知参数: ${Key}`)
    const Val = Argv[i + 1]
    if (Val === undefined) throw new Error('--limit 缺值')
    const Count = Number(Val)
    if (!Number.isInteger(Count) || Count < 1) throw new Error('--limit 需为正整数')
    Limit = Count
    i++
  }
  return { limit: Limit }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (Err: unknown) => {
    console.error(`\neval-seed 失败: ${Err instanceof Error ? Err.message : String(Err)}`)
    process.exit(1)
  },
)
