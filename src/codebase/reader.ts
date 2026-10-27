/**
 * 代码库读侧 —— 文件树、单文件预览/下载、原 ZIP 302 目标。
 * 预览用 S3 range reader 只读 ZIP 的局部，不把整包下载到本地、不解压到文件系统；
 * 实际解压字节超过 100MB 会中止流。文本/代码一律按 text/plain 返回，绝不把条目标 HTML/SVG 执行。
 */

export { CodebaseReader, CodebaseReadError, MAX_PREVIEW_BYTES }

import { Transform } from 'node:stream'
import type { Readable } from 'node:stream'
import { inject, singleton } from 'tsyringe'
import { fromRandomAccessReaderPromise } from 'yauzl'
import type { Entry, ZipFile } from 'yauzl'
import { AppConfig } from '../config'
import { ObjectStoreHandle, PostgresCodebaseRepo } from '../adapter/contract'
import type { Codebase, CodebaseEntry, CodebaseRepo } from '../adapter/contract'
import { attachmentDisposition, inlineDisposition } from '../adapter/storage/disposition'
import { fileNameFromKey, parseDataUri } from '../adapter/storage/uri'
import { S3ZipReader } from './s3-reader'

interface CodebaseFile {
  stream: Readable
  fileName: string
  contentType: string
  disposition: string
}

interface OriginalTarget {
  url: string
  fileName: string
}

class CodebaseReadError extends Error {
  readonly code: string
  readonly codebase: Codebase | null

  constructor(Code: string, Message: string, Codebase: Codebase | null = null) {
    super(Message)
    this.name = 'CodebaseReadError'
    this.code = Code
    this.codebase = Codebase
  }
}

const MAX_PREVIEW_BYTES = 100 * 1024 * 1024
const PRESIGN_TTL_SECONDS = 3600
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'yml', 'yaml', 'toml', 'ini', 'conf',
  'sh', 'bash', 'zsh', 'ps1', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'php', 'rb', 'swift', 'm', 'mm', 'scala', 'vue', 'svelte', 'astro', 'sql', 'graphql', 'gql',
  'csv', 'tsv', 'log', 'env', 'lock', 'diff', 'patch', 'properties', 'gradle', 'dockerfile', 'makefile',
])
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', 'changelog', '.gitignore', '.dockerignore', '.env'])

@singleton()
class CodebaseReader {
  private readonly config: AppConfig
  private readonly store: ObjectStoreHandle
  private readonly repo: CodebaseRepo

  constructor(
    @inject(AppConfig) Config: AppConfig,
    @inject(ObjectStoreHandle) Store: ObjectStoreHandle,
    @inject(PostgresCodebaseRepo) Repo: CodebaseRepo,
  ) {
    this.config = Config
    this.store = Store
    this.repo = Repo
  }

  async tree(Id: string): Promise<CodebaseEntry[]> {
    const codebase = await this.ready(Id)
    return codebase.manifest
  }

  async file(Id: string, EntryIndex: number, Download: boolean): Promise<CodebaseFile> {
    const codebase = await this.ready(Id)
    const entry = codebase.manifest.find((Item) => Item.entry_index === EntryIndex)
    if (!entry) throw new CodebaseReadError('E_ENTRY_NOT_FOUND', `ZIP 条目不存在: ${EntryIndex}`, codebase)
    if (entry.is_dir) throw new CodebaseReadError('E_IS_DIRECTORY', `这是目录，不能预览: ${entry.path}`, codebase)

    const { key, size } = await this.originalParts(codebase)
    const reader = new S3ZipReader(this.store, key, size)
    let zip: ZipFile
    try {
      zip = await fromRandomAccessReaderPromise(reader, size, { lazyEntries: true, autoClose: false, validateEntrySizes: false, strictFileNames: true })
    } catch (err) {
      throw new CodebaseReadError('E_ZIP_READ_FAILED', `读取 ZIP 失败: ${errMessage(err)}`, codebase)
    }

    let found: Entry | null = null
    let current = 0
    try {
      for await (const candidate of zip.eachEntry()) {
        if (current === EntryIndex) {
          found = candidate
          break
        }
        current += 1
      }
    } catch (err) {
      zip.close()
      throw new CodebaseReadError('E_ZIP_READ_FAILED', `读取 ZIP 失败: ${errMessage(err)}`, codebase)
    }

    if (!found) {
      zip.close()
      throw new CodebaseReadError('E_ENTRY_NOT_FOUND', `ZIP 条目不存在: ${EntryIndex}`, codebase)
    }
    if (found.fileName !== entry.path || found.isEncrypted() || !found.canDecodeFileData()) {
      zip.close()
      throw new CodebaseReadError('E_ENTRY_DRIFT', `ZIP 条目与清单不一致: ${entry.path}`, codebase)
    }
    if (found.uncompressedSize > MAX_PREVIEW_BYTES) {
      zip.close()
      throw new CodebaseReadError('E_FILE_TOO_LARGE', `文件超过 ${MAX_PREVIEW_BYTES} 字节`, codebase)
    }

    let source: Readable
    try {
      source = await zip.openReadStreamPromise(found)
    } catch (err) {
      zip.close()
      throw new CodebaseReadError('E_ZIP_READ_FAILED', `读取 ZIP 条目失败: ${errMessage(err)}`, codebase)
    }

    let seen = 0
    const limited = new Transform({
      transform(Chunk, _Encoding, Callback) {
        seen += Chunk.length
        if (seen > MAX_PREVIEW_BYTES) {
          Callback(new CodebaseReadError('E_FILE_TOO_LARGE', `文件超过 ${MAX_PREVIEW_BYTES} 字节`, codebase))
          return
        }
        Callback(null, Chunk)
      },
    })
    const stream = source.pipe(limited)
    const close = () => zip.close()
    stream.once('end', close)
    stream.once('close', close)
    stream.once('error', close)

    const fileName = fileNameFromKey(entry.path) || 'file'
    const isText = !Download && isTextPath(entry.path)
    return {
      stream,
      fileName,
      contentType: isText ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      disposition: Download ? attachmentDisposition(fileName) : inlineDisposition(fileName),
    }
  }

  async original(Id: string): Promise<OriginalTarget> {
    const codebase = await this.ready(Id)
    const { key } = await this.originalParts(codebase)
    const fileName = codebase.original_filename || 'codebase.zip'
    try {
      const url = await this.store.presignGet(key, {
        expiresIn: PRESIGN_TTL_SECONDS,
        responseContentDisposition: attachmentDisposition(fileName),
        responseContentType: 'application/zip',
        responseCacheControl: 'no-store',
      })
      return { url, fileName }
    } catch {
      throw new CodebaseReadError('E_PRESIGN_FAILED', '生成下载地址失败', codebase)
    }
  }

  private async ready(Id: string): Promise<Codebase> {
    const codebase = await this.repo.getCodebase(Id)
    if (!codebase) throw new CodebaseReadError('E_NOT_FOUND', '代码库不存在')
    if (codebase.status !== 'ready') {
      throw new CodebaseReadError('E_NOT_READY', `代码库状态是 ${codebase.status}，还没有可读清单`, codebase)
    }
    return codebase
  }

  private async originalParts(codebase: Codebase): Promise<{ key: string; size: number }> {
    let parts: ReturnType<typeof parseDataUri>
    try {
      parts = parseDataUri(codebase.data_uri)
    } catch {
      throw new CodebaseReadError('E_NO_ORIGINAL', '原始 ZIP 不存在或 data_uri 不是 kc:// URI', codebase)
    }
    if (parts.bucket !== this.config.s3Bucket) {
      throw new CodebaseReadError('E_NO_ORIGINAL', 'data_uri bucket 与当前桶不一致', codebase)
    }
    const size = codebase.storage_size_bytes ?? (await this.store.stat(parts.key))?.size
    if (size === undefined) throw new CodebaseReadError('E_NO_ORIGINAL', '原始 ZIP 不存在', codebase)
    return { key: parts.key, size }
  }
}

function isTextPath(Path: string): boolean {
  const Name = fileNameFromKey(Path).toLowerCase()
  if (TEXT_NAMES.has(Name)) return true
  const Dot = Name.lastIndexOf('.')
  return Dot > 0 && TEXT_EXT.has(Name.slice(Dot + 1))
}

function errMessage(Err: unknown): string {
  return Err instanceof Error ? Err.message : String(Err)
}
