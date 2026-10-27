/**
 * 代码库上传 —— 建 uploading 行并签 presignPut；complete 时 stat、下载 ZIP 到受控临时文件、
 * 只读中央目录做安全校验，再写 manifest 转 ready。不解压条目、不写条目文件、不执行仓库内容。
 * 失败删错对象并把原因留在行上；行保留可看，硬删走 DELETE /codebases/:id。
 */

export { CodebaseArchive, CodebaseError, MAX_CODEBASE_BYTES }

import 'reflect-metadata'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { inject, singleton } from 'tsyringe'
import { AppConfig } from '../config'
import { ObjectStoreHandle, PostgresCodebaseRepo } from '../adapter/contract'
import type { Codebase, CodebaseRepo } from '../adapter/contract'
import { allocateKey, buildDataUri, keyForCodebase, parseDataUri, StorageUriError } from '../adapter/storage/uri'
import { logError } from '../trace/systemtrace/log'
import { inspectZip, ZipError } from './zip'
import type { ZipInspection } from './zip'

interface CodebaseUpload {
  url: string
  method: 'PUT'
  contentType: string
}

interface CodebaseUploadResult {
  codebase: Codebase
  upload: CodebaseUpload
}

class CodebaseError extends Error {
  readonly code: string
  readonly codebase: Codebase | null

  constructor(Code: string, Message: string, Codebase: Codebase | null = null) {
    super(Message)
    this.name = 'CodebaseError'
    this.code = Code
    this.codebase = Codebase
  }
}

const MAX_CODEBASE_BYTES = 100 * 1024 * 1024
const PRESIGN_TTL_SECONDS = 3600
const ZIP_MIME = 'application/zip'
const ZIP_MIMES = new Set([ZIP_MIME, 'application/x-zip-compressed'])

@singleton()
class CodebaseArchive {
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

  async createUpload(Filename: string, Size: number | undefined, Title: string | undefined): Promise<CodebaseUploadResult> {
    const filename = Filename.trim()
    if (filename === '') throw new CodebaseError('E_BAD_FILENAME', '文件名不能为空')
    if (Size !== undefined && (!Number.isInteger(Size) || Size < 0)) {
      throw new CodebaseError('E_BAD_SIZE', `size 需为非负整数: ${Size}`)
    }
    if (Size !== undefined && Size > MAX_CODEBASE_BYTES) {
      throw new CodebaseError('E_TOO_LARGE', `ZIP 超过 ${MAX_CODEBASE_BYTES} 字节: ${Size}`)
    }

    let base: string
    try {
      base = keyForCodebase(filename)
    } catch (err) {
      throw fromKeyError(err)
    }

    const { key, dataUri } = await this.allocate(base)
    const codebase = await this.repo.createCodebase({
      title: Title?.trim() || titleFromFilename(filename),
      original_filename: filename,
      data_uri: dataUri,
      content_type: ZIP_MIME,
      status: 'uploading',
    })

    try {
      const url = await this.store.presignPut(key, { expiresIn: PRESIGN_TTL_SECONDS, contentType: ZIP_MIME })
      return { codebase, upload: { url, method: 'PUT', contentType: ZIP_MIME } }
    } catch (err) {
      return await this.fail(codebase, 'E_PRESIGN_FAILED', '生成上传地址失败', false, err)
    }
  }

  async complete(Id: string): Promise<Codebase> {
    const codebase = await this.repo.getCodebase(Id)
    if (!codebase) throw new CodebaseError('E_NOT_FOUND', '代码库不存在')
    if (codebase.status !== 'uploading') {
      throw new CodebaseError('E_NOT_UPLOADING', `代码库状态是 ${codebase.status}，不能完成上传`, codebase)
    }

    let parts: ReturnType<typeof parseDataUri>
    try {
      parts = parseDataUri(codebase.data_uri)
    } catch (err) {
      return await this.fail(codebase, 'E_BAD_ORIGINAL', err instanceof Error ? err.message : String(err), false)
    }
    if (parts.bucket !== this.config.s3Bucket) {
      return await this.fail(codebase, 'E_BAD_ORIGINAL', `data_uri bucket 不匹配: ${parts.bucket}`, false)
    }

    const stat = await this.store.stat(parts.key)
    if (!stat) return await this.fail(codebase, 'E_UPLOAD_INCOMPLETE', '原始 ZIP 不存在', false)
    if (stat.size === 0) return await this.fail(codebase, 'E_UPLOAD_EMPTY', '原始 ZIP 为空', true, undefined, parts.key)
    if (stat.size > MAX_CODEBASE_BYTES) {
      return await this.fail(codebase, 'E_UPLOAD_TOO_LARGE', `原始 ZIP 超过 ${MAX_CODEBASE_BYTES} 字节`, true, undefined, parts.key)
    }
    if (!ZIP_MIMES.has(normalizeMime(stat.contentType))) {
      return await this.fail(codebase, 'E_UPLOAD_TYPE_MISMATCH', `对象类型 ${stat.contentType ?? '空'} 不是 ZIP`, true, undefined, parts.key)
    }

    if (!(await this.repo.updateCodebaseStatus(codebase.id, 'processing'))) {
      throw new CodebaseError('E_NOT_FOUND', '代码库在上传确认期间被删除', codebase)
    }
    const processing = { ...codebase, status: 'processing' as const }

    const dir = await mkdtemp(join(tmpdir(), 'kc-codebase-'))
    const file = join(dir, 'upload.zip')
    try {
      let bytes: number
      try {
        bytes = await this.download(parts.key, file)
      } catch (err) {
        return await this.fail(processing, 'E_DOWNLOAD_FAILED', `读取原始 ZIP 失败: ${errMessage(err)}`, true, err, parts.key)
      }
      if (bytes > MAX_CODEBASE_BYTES) {
        return await this.fail(processing, 'E_UPLOAD_TOO_LARGE', `原始 ZIP 超过 ${MAX_CODEBASE_BYTES} 字节`, true, undefined, parts.key)
      }

      let inspection: ZipInspection
      try {
        inspection = await inspectZip(file)
      } catch (err) {
        const code = err instanceof ZipError ? err.code : 'E_ZIP_INVALID'
        return await this.fail(processing, code, errMessage(err), true, err, parts.key)
      }

      const ready = await this.repo.markCodebaseReady(codebase.id, {
        storage_size_bytes: bytes,
        manifest: inspection.manifest,
        file_count: inspection.fileCount,
        declared_uncompressed_bytes: inspection.declaredUncompressedBytes,
      })
      if (!ready) throw new CodebaseError('E_NOT_FOUND', '代码库在完成校验期间被删除', codebase)
      return ready
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  private async allocate(BaseKey: string): Promise<{ key: string; dataUri: string }> {
    const key = await allocateKey(BaseKey, async (Candidate) => {
      const dataUri = buildDataUri(this.config.s3Bucket, Candidate)
      if (await this.repo.codebaseDataUriExists(dataUri)) return true
      return (await this.store.stat(Candidate)) !== null
    })
    return { key, dataUri: buildDataUri(this.config.s3Bucket, key) }
  }

  private async download(Key: string, Path: string): Promise<number> {
    const object = await this.store.get(Key)
    if (!object) throw new Error('原始 ZIP 不存在')

    let bytes = 0
    const Counter = new Transform({
      transform(Chunk, _Encoding, Callback) {
        bytes += Chunk.length
        if (bytes > MAX_CODEBASE_BYTES) {
          Callback(new Error(`ZIP 超过 ${MAX_CODEBASE_BYTES} 字节`))
          return
        }
        Callback(null, Chunk)
      },
    })
    await pipeline(object.body, Counter, createWriteStream(Path))
    return bytes
  }

  private async fail(
    Codebase: Codebase,
    Code: string,
    Reason: string,
    DeleteObject: boolean,
    Cause?: unknown,
    Key?: string,
  ): Promise<never> {
    logError(Code, Reason, {
      codebase_id: Codebase.id,
      ...(Cause === undefined ? {} : { cause: errMessage(Cause) }),
    })
    if (DeleteObject && Key !== undefined) {
      await this.store.delete(Key).catch((err) => logError('E_CODEBASE_OBJECT_DELETE', String(err), { codebase_id: Codebase.id }))
    }
    await this.repo.updateCodebaseStatus(Codebase.id, 'failed', Reason)
      .catch((err) => logError('E_CODEBASE_MARK', String(err), { codebase_id: Codebase.id }))
    throw new CodebaseError(Code, Reason, { ...Codebase, status: 'failed', error_reason: Reason })
  }
}

function fromKeyError(Err: unknown): CodebaseError {
  if (Err instanceof StorageUriError) return new CodebaseError('E_BAD_FILENAME', Err.message)
  return new CodebaseError('E_BAD_FILENAME', errMessage(Err))
}

function normalizeMime(Raw: string | null | undefined): string {
  return (Raw ?? '').split(';', 1)[0]!.trim().toLowerCase()
}

function titleFromFilename(Filename: string): string {
  return Filename.replace(/\.zip$/i, '') || '代码库'
}

function errMessage(Err: unknown): string {
  return Err instanceof Error ? Err.message : String(Err)
}
