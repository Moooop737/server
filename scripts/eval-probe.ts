/**
 * 检索探底 CLI —— 读一批问题，走生产 Retriever（与 /retrieve 同一只实例）跑一遍，打印每条命中与文档级指标。
 * 定位：Epic 7 Step 1「先看当前错在哪」的重复工具，不是正式评测——无 chunk 级 gold、不落库、不写 Langfuse。
 * 跑法：npm run eval:probe -- [--cases scripts/eval-cases.json] [--level L2] [--json /tmp/report.json]
 * 条数与阈值只认管线自身 config，本脚本不传覆盖。
 * 不传 sink → NoopStageSink 且 embed telemetry 关闭，因此不写 trace_stages、不进 Langfuse。
 * 匹配口径：case.expect[].path 是 dataUri 片段；带了 chunkIndex 就精确到块，否则只认文档。
 * 指标：正例记首个相关命中的名次（hit@k / MRR）；负例看命中数与 top1 相似度，0 命中才算正确拒答。
 */

import 'reflect-metadata'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { container } from 'tsyringe'
import { RuntimeRetrievalRegistry } from '../src/adapter/contract'
import { RuntimeModelRegistry } from '../src/adapter/model/runtime-registry'
import type { RetrievedChunk } from '../src/retrieve/contracts'

interface CaseExpect {
  path: string
  chunkIndex?: number
}

interface ProbeCase {
  id: string
  level: string
  query: string
  expect: CaseExpect[]
  negative?: boolean
  note?: string
}

interface CaseSpec {
  name: string
  cases: ProbeCase[]
}

interface ProbeArgs {
  cases: string
  level: string | null
  json: string | null
}

interface HitRow {
  rank: number
  path: string
  chunkIndex: number
  matched: boolean
  score: number
  similarity: number | null
  lexicalScore: number | null
}

interface CaseRow {
  id: string
  level: string
  query: string
  negative: boolean
  status: 'ok' | 'error'
  error: string | null
  rank: number | null
  hit: boolean
  hits: HitRow[]
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const URI_PREFIX = /^kc:\/\/oss\/minio\/[^/]+\//

async function main(): Promise<void> {
  const Args = parseArgs(process.argv.slice(2))
  const Spec = readSpec(Args.cases)
  const Selected = Args.level === null ? Spec.cases : Spec.cases.filter((C) => C.level === Args.level)
  if (Selected.length === 0) throw new Error(`没有匹配的 case（level=${Args.level ?? '全部'}）`)

  const Retrieval = container.resolve(RuntimeRetrievalRegistry)
  await Retrieval.load()
  const Embedding = container.resolve(RuntimeModelRegistry).requireEmbeddingDefault()

  console.log(`\neval-probe  ${Spec.name}  cases=${Selected.length}  model=${Embedding.model_id}  dim=${Embedding.dimensions}\n`)

  const Rows: CaseRow[] = []
  for (const C of Selected) {
    const Row = await runCase(Retrieval, C)
    Rows.push(Row)
    printCase(Row)
  }
  printSummary(Rows)

  if (Args.json !== null) {
    mkdirSync(dirname(resolve(Args.json)), { recursive: true })
    writeFileSync(Args.json, JSON.stringify({ spec: Spec.name, model: Embedding.model_id, dimensions: Embedding.dimensions, cases: Rows }, null, 2))
    console.log(`\n报告已写入 ${Args.json}`)
  }
}

async function runCase(Retrieval: RuntimeRetrievalRegistry, C: ProbeCase): Promise<CaseRow> {
  const Base = { id: C.id, level: C.level, query: C.query, negative: C.negative === true }
  try {
    const Result = await Retrieval.retriever().search(C.query)
    const Hits: HitRow[] = Result.hits.map((Hit, Index) => ({
      rank: Index + 1,
      path: shortPath(Hit.dataUri),
      chunkIndex: Hit.chunk.chunk_index,
      matched: matches(Hit, C.expect),
      score: Hit.score,
      similarity: Hit.similarity,
      lexicalScore: Hit.lexicalScore,
    }))
    const First = Hits.find((H) => H.matched)
    return { ...Base, status: 'ok', error: null, rank: First === undefined ? null : First.rank, hit: First !== undefined, hits: Hits }
  } catch (err) {
    return { ...Base, status: 'error', error: String(err), rank: null, hit: false, hits: [] }
  }
}

function matches(Hit: RetrievedChunk, Expect: CaseExpect[]): boolean {
  return Expect.some((E) => {
    if (!Hit.dataUri.includes(E.path)) return false
    return E.chunkIndex === undefined || Hit.chunk.chunk_index === E.chunkIndex
  })
}

function shortPath(Uri: string): string {
  const Clean = Uri.replace(URI_PREFIX, '')
  const Parts = Clean.split('/')
  return Parts.length <= 2 ? Clean : `${Parts.at(-2) ?? ''}/${Parts.at(-1) ?? ''}`
}

function printCase(Row: CaseRow): void {
  if (Row.status === 'error') {
    console.log(`[${Row.level}] ${Row.id} ✗ 检索失败: ${Row.error}`)
    console.log(`      ${Row.query}\n`)
    return
  }
  if (Row.negative) {
    const Clean = Row.hits.length === 0
    const Top = Row.hits[0]
    const Detail = Clean ? '0 命中' : `命中 ${Row.hits.length} 条, top1 sim ${fmt(Top?.similarity ?? null, 3)}`
    console.log(`[${Row.level}] ${Row.id} ${Clean ? '✓' : '⚠'} ${Detail}   ${Row.query}`)
  } else {
    console.log(`[${Row.level}] ${Row.id} ${Row.hit ? '✓' : '✗'} rank=${Row.rank ?? 'MISS'}   ${Row.query}`)
  }
  for (const H of Row.hits) {
    const Padded = H.path.length > 50 ? `…${H.path.slice(-49)}` : H.path
    console.log(`      ${String(H.rank).padStart(2)} ${H.matched ? '✓' : ' '} ${Padded.padEnd(50)} #${String(H.chunkIndex).padStart(3)}  sim ${fmt(H.similarity, 3)}  lex ${fmt(H.lexicalScore, 2)}`)
  }
  console.log('')
}

function printSummary(Rows: CaseRow[]): void {
  const Positive = Rows.filter((R) => !R.negative)
  const Negative = Rows.filter((R) => R.negative)
  const HitPositive = Positive.filter((R) => R.hit)
  const Mre = Positive.length === 0 ? 0 : HitPositive.reduce((Sum, R) => Sum + 1 / (R.rank ?? Infinity), 0) / Positive.length
  const CleanNegative = Negative.filter((R) => R.hits.length === 0)

  console.log('─'.repeat(78))
  console.log(`正例  ${HitPositive.length}/${Positive.length} 命中    MRR ${Mre.toFixed(3)}`)
  if (Negative.length > 0) {
    const Sims = Negative.map((R) => `top1 sim ${fmt(R.hits[0]?.similarity ?? null, 3)}`).join(', ')
    console.log(`负例  ${CleanNegative.length}/${Negative.length} 正确拒答    ${Sims}`)
  }
  const Levels = [...new Set(Rows.map((R) => R.level))].sort()
  const PerLevel = Levels.map((L) => {
    const Group = Rows.filter((R) => R.level === L)
    const Pass = Group.filter((R) => (R.negative ? R.hits.length === 0 : R.hit)).length
    return `${L} ${Pass}/${Group.length}`
  })
  console.log(`分档  ${PerLevel.join('   ')}`)
  const Errors = Rows.filter((R) => R.status === 'error')
  if (Errors.length > 0) console.log(`错误  ${Errors.map((R) => R.id).join(', ')}`)
}

function fmt(Value: number | null, Digits: number): string {
  return Value === null ? '  -  ' : Value.toFixed(Digits)
}

function parseArgs(Argv: string[]): ProbeArgs {
  const Out: ProbeArgs = { cases: resolve(SCRIPT_DIR, 'eval-cases.json'), level: null, json: null }
  for (let i = 0; i < Argv.length; i++) {
    const Key = Argv[i]
    const Val = Argv[i + 1]
    if (Key === '--help' || Key === '-h') {
      console.log('用法: npm run eval:probe -- [--cases <path>] [--level <L1|L2|L3|L4|L5>] [--json <path>]')
      process.exit(0)
    }
    if (Val === undefined) throw new Error(`参数 ${Key} 缺值`)
    if (Key === '--cases') Out.cases = resolve(Val)
    else if (Key === '--level') Out.level = Val
    else if (Key === '--json') Out.json = resolve(Val)
    else throw new Error(`未知参数: ${Key}`)
    i++
  }
  return Out
}

function readSpec(Path: string): CaseSpec {
  const Parsed = JSON.parse(readFileSync(Path, 'utf8')) as Partial<CaseSpec>
  if (typeof Parsed.name !== 'string' || !Array.isArray(Parsed.cases) || Parsed.cases.length === 0) {
    throw new Error(`${Path} 形状不对：需要 { name, cases: [...] }`)
  }
  for (const [Index, C] of Parsed.cases.entries()) {
    if (typeof C.id !== 'string' || typeof C.query !== 'string' || typeof C.level !== 'string' || !Array.isArray(C.expect)) {
      throw new Error(`${Path} 第 ${Index + 1} 条 case 缺 id/level/query/expect`)
    }
    if (C.negative !== true && C.expect.length === 0) {
      throw new Error(`${Path} 第 ${Index + 1} 条 case 没有 expect 又不是 negative`)
    }
  }
  return { name: Parsed.name, cases: Parsed.cases }
}

main().then(
  () => process.exit(0),
  (Err: unknown) => {
    console.error(`\neval-probe 失败: ${Err instanceof Error ? Err.message : String(Err)}`)
    process.exit(1)
  },
)
