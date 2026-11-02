/**
 * codebase 读路径基线 —— 真 MinIO + 1500 条目 ZIP，量 complete / tree / 首尾文件预览的耗时与 S3 请求量。
 * 仅做性能对比：脚本结束删对象与 codebases 行；不写业务表。
 */

import 'reflect-metadata'
import { randomBytes, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { ZipFile } from 'yazl'
import { container } from 'tsyringe'
import { CodebaseArchive } from '../src/codebase/archive'
import { CodebaseReader } from '../src/codebase/reader'
import { createDbPool } from '../src/adapter/connection/pool'
import { ObjectStoreHandle, PostgresCodebaseRepo } from '../src/adapter/contract'
import { parseDataUri } from '../src/adapter/storage/uri'

const FILES = 1500
const BYTES_PER_FILE = 64 * 1024
const PREFIX = '__bench_codebase__'

interface Counters {
  getCalls: number
  getBytes: number
  statCalls: number
}

const pool = createDbPool(process.env.DATABASE_URL!)
const store = container.resolve(ObjectStoreHandle)
const repo = container.resolve(PostgresCodebaseRepo)
const archive = container.resolve(CodebaseArchive)
const reader = container.resolve(CodebaseReader)

const counters: Counters = { getCalls: 0, getBytes: 0, statCalls: 0 }

const originalGet = store.get.bind(store)
store.get = async (Key, Options) => {
  counters.getCalls += 1
  if (Options?.range !== undefined) {
    const Match = /^bytes=(\d+)-(\d+)$/.exec(Options.range)
    if (Match) counters.getBytes += Number(Match[2]) - Number(Match[1]) + 1
  }
  const object = await originalGet(Key, Options)
  if (object !== null && Options?.range === undefined) counters.getBytes += object.contentLength ?? 0
  return object
}

const originalStat = store.stat.bind(store)
store.stat = async (Key) => {
  counters.statCalls += 1
  return originalStat(Key)
}

function reset(): Counters {
  counters.getCalls = 0
  counters.getBytes = 0
  counters.statCalls = 0
  return { ...counters }
}

async function zipOf(Count: number, Bytes: number): Promise<Buffer> {
  const Zip = new ZipFile()
  for (let Index = 0; Index < Count; Index += 1) {
    Zip.addBuffer(randomBytes(Bytes), `files/f-${String(Index).padStart(4, '0')}.bin`)
  }
  Zip.end()
  const Chunks: Buffer[] = []
  for await (const Chunk of Zip.outputStream) Chunks.push(Buffer.from(Chunk as Uint8Array))
  return Buffer.concat(Chunks)
}

async function readStream(Stream: NodeJS.ReadableStream): Promise<number> {
  let Bytes = 0
  for await (const Chunk of Stream) Bytes += Buffer.from(Chunk as Uint8Array).length
  return Bytes
}

async function main(): Promise<void> {
  const Zip = await zipOf(FILES, BYTES_PER_FILE)
  const Created = await archive.createUpload(`${PREFIX}-${randomUUID()}.zip`, Zip.length, PREFIX)
  const Id = Created.codebase.id
  const Key = parseDataUri(Created.codebase.data_uri).key

  try {
    await store.put(Key, Zip, 'application/zip')

    reset()
    const CompleteStarted = performance.now()
    const Ready = await archive.complete(Id)
    const CompleteMs = performance.now() - CompleteStarted
    const CompleteCounters = { ...counters }

    reset()
    const TreeStarted = performance.now()
    const Entries = await reader.tree(Id)
    const TreeMs = performance.now() - TreeStarted
    const TreeCounters = { ...counters }

    const First = Entries[0]!
    const Last = Entries.at(-1)!
    reset()
    const FirstStarted = performance.now()
    const FirstFile = await reader.file(Id, First.entry_index, false)
    const FirstBytes = await readStream(FirstFile.stream)
    const FirstMs = performance.now() - FirstStarted
    const FirstCounters = { ...counters }

    reset()
    const LastStarted = performance.now()
    const LastFile = await reader.file(Id, Last.entry_index, false)
    const LastBytes = await readStream(LastFile.stream)
    const LastMs = performance.now() - LastStarted
    const LastCounters = { ...counters }

    console.log(JSON.stringify({
      zip: { bytes: Zip.length, files: FILES, bytesPerFile: BYTES_PER_FILE },
      manifest: { entries: Entries.length, first: First.path, last: Last.path, ready: Ready.status },
      complete: { ms: Math.round(CompleteMs), ...CompleteCounters },
      tree: { ms: Math.round(TreeMs), ...TreeCounters },
      fileFirst: { entryIndex: First.entry_index, ms: Math.round(FirstMs), bytes: FirstBytes, ...FirstCounters },
      fileLast: { entryIndex: Last.entry_index, ms: Math.round(LastMs), bytes: LastBytes, ...LastCounters },
    }, null, 2))
  } finally {
    await store.delete(Key).catch(() => {})
    await pool.query('DELETE FROM codebases WHERE id = $1', [Id]).catch(() => {})
    await pool.end()
  }
}

void main()
