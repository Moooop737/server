/**
 * 资源上传/归档 —— 把文件、URL、粘贴文本变成一条资源行 + MinIO 里的原始对象。
 * 去重门在 DB 建行与 MinIO 写入之前：先算 SHA-256 查库，命中就不 create/presign/PUT/put；
 * active 命中只返回已有资源；软删命中且对象完整则恢复该资源，对象损坏返回 E_ORIGINAL_LOST。
 * 文件只建 uploading 行并返回 presignPut 目标；URL/粘贴由本服务抓取/写入后直接到 uploaded。
 * 只负责原始内容，不解析、不切块、不写向量；那一步由 ingest 读 data_uri 完成。
 */

export { ResourceArchive, ArchiveError, MAX_RESOURCE_BYTES }
export type { ArchivedResource, FileUpload, FileUploadResult }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { AppConfig } from '../config'
import { ObjectStoreHandle, PostgresRepo } from '../adapter/contract'
import type { Repo, Resource } from '../adapter/contract'
import { HttpFetcher } from '../ingest/fetch/http-fetcher'
import type { IngestContext } from '../ingest/contracts'
import {
  allocateKey, buildDataUri, fileNameFromKey, keyForPaste, keyForUpload, keyForUrl, mimeFromKey, StorageUriError,
} from '../adapter/storage/uri'
import { logError } from '../trace/systemtrace/log'
import { ResourceRestore, RestoreError } from './restore'
import { isSha256Hex, sha256Hex } from '../adapter/storage/hash'

interface ArchivedResource {
  resource: Resource
  duplicate?: boolean
  restored?: boolean
}

interface FileUpload {
  url: string
  method: 'PUT'
  contentType: string
}

interface FileUploadResult extends ArchivedResource {
  upload?: FileUpload
}

class ArchiveError extends Error {
  readonly code: string
  readonly resource: Resource | null

  constructor(Code: string, Message: string, Resource: Resource | null = null) {
    super(Message)
    this.name = 'ArchiveError'
    this.code = Code
    this.resource = Resource
  }
}

const MAX_RESOURCE_BYTES = 10 * 1024 * 1024
const PRESIGN_TTL_SECONDS = 3600
const DEFAULT_PASTE_TITLE = '粘贴内容'
const DEFAULT_URL_TITLE = '未命名'

@singleton()
class ResourceArchive {
  private readonly config: AppConfig
  private readonly store: ObjectStoreHandle
  private readonly repo: Repo
  private readonly restore: ResourceRestore
  private readonly fetcher = new HttpFetcher()

  constructor(
    @inject(AppConfig) Config: AppConfig,
    @inject(ObjectStoreHandle) Store: ObjectStoreHandle,
    @inject(PostgresRepo) Repo: Repo,
    @inject(ResourceRestore) Restore: ResourceRestore,
  ) {
    this.config = Config
    this.store = Store
    this.repo = Repo
    this.restore = Restore
  }

  async createFile(Filename: string, Size: number | undefined, Title: string | undefined, ContentHash: string): Promise<FileUploadResult> {
    const filename = Filename.trim()
    if (filename === '') throw new ArchiveError('E_BAD_FILENAME', '文件名不能为空')
    if (!isSha256Hex(ContentHash)) throw new ArchiveError('E_BAD_HASH', 'content_hash 必须是 64 位小写 SHA-256 hex')

    let base: string
    try {
      base = keyForUpload(filename)
    } catch (err) {
      throw fromKeyError(err, 'E_BAD_FILENAME')
    }
    const mime = mimeFromKey(base)
    if (mime !== 'text/markdown' && mime !== 'text/plain') {
      throw new ArchiveError('E_BAD_CONTENT_TYPE', `文件只支持 .md/.txt: ${filename}`)
    }
    if (Size !== undefined && (!Number.isInteger(Size) || Size < 0)) {
      throw new ArchiveError('E_BAD_SIZE', `size 需为非负整数: ${Size}`)
    }
    if (Size !== undefined && Size > MAX_RESOURCE_BYTES) {
      throw new ArchiveError('E_TOO_LARGE', `文件超过 ${MAX_RESOURCE_BYTES} 字节: ${Size}`)
    }

    const hit = await this.findByHash(ContentHash)
    if (hit) return hit

    const { key, dataUri } = await this.allocate(base)
    const created = await this.createNew({
      title: Title?.trim() || titleFromKey(key),
      source: null,
      data_uri: dataUri,
      content_type: mime,
      content_hash: ContentHash,
    })
    if (created.hit) return created.hit
    const resource = created.resource

    try {
      const url = await this.store.presignPut(key, { expiresIn: PRESIGN_TTL_SECONDS, contentType: mime })
      return { resource, upload: { url, method: 'PUT', contentType: mime } }
    } catch (err) {
      return await this.fail(resource, 'E_PRESIGN_FAILED', '生成上传地址失败', err)
    }
  }

  async archiveUrl(Url: string, Title: string | undefined): Promise<ArchivedResource> {
    let base: string
    try {
      base = keyForUrl(Url)
    } catch (err) {
      throw fromKeyError(err, 'E_BAD_URL')
    }

    const duplicate = await this.repo.findActiveBySource(Url)
    if (duplicate) throw new ArchiveError('E_DUPLICATE', '同 URL 已有未删除资源', duplicate)

    let fetched
    try {
      const ctx: IngestContext = { data: { content_type: 'url', url: Url } }
      await this.fetcher.run(ctx)
      fetched = ctx.fetched
    } catch (err) {
      return await this.failedUrl(Url, Title, base, 'E_ARCHIVE_FAILED', '抓取失败', err)
    }
    if (!fetched || fetched.raw.trim() === '') {
      return await this.failedUrl(Url, Title, base, 'E_EMPTY_CONTENT', '抓取结果为空')
    }
    const mime = normalizeUrlMime(fetched.content_type)
    if (mime === null) {
      return await this.failedUrl(Url, Title, base, 'E_UNSUPPORTED_CONTENT_TYPE', `不支持的内容类型: ${fetched.content_type ?? '空'}`)
    }
    const bytes = Buffer.from(fetched.raw, 'utf8')
    if (bytes.length > MAX_RESOURCE_BYTES) {
      return await this.failedUrl(Url, Title, base, 'E_TOO_LARGE', `内容超过 ${MAX_RESOURCE_BYTES} 字节: ${bytes.length}`)
    }
    const hash = sha256Hex(bytes)

    const hit = await this.findByHash(hash)
    if (hit) return hit

    const { key, dataUri } = await this.allocate(base)
    const created = await this.createNew({
      title: Title?.trim() || hostnameOf(Url),
      source: Url,
      data_uri: dataUri,
      content_type: mime,
      content_hash: hash,
    })
    if (created.hit) return created.hit
    const resource = created.resource

    try {
      await this.store.put(key, bytes, mime)
      return { resource: await this.markUploaded(resource, bytes.length, mime) }
    } catch (err) {
      if (err instanceof ArchiveError) throw err
      return await this.fail(resource, 'E_ARCHIVE_FAILED', '写入对象存储失败', err)
    }
  }

  async archiveText(Content: string, ContentType: string, Title: string | undefined): Promise<ArchivedResource> {
    if (Content.trim() === '') throw new ArchiveError('E_EMPTY_CONTENT', '内容不能为空')
    const mime = normalizePasteMime(ContentType)
    if (mime === null) {
      throw new ArchiveError('E_BAD_CONTENT_TYPE', `粘贴只支持 text/markdown 或 text/plain: ${ContentType}`)
    }
    const bytes = Buffer.from(Content, 'utf8')
    if (bytes.length > MAX_RESOURCE_BYTES) {
      throw new ArchiveError('E_TOO_LARGE', `内容超过 ${MAX_RESOURCE_BYTES} 字节: ${bytes.length}`)
    }
    const hash = sha256Hex(bytes)

    const hit = await this.findByHash(hash)
    if (hit) return hit

    let base: string
    try {
      base = keyForPaste(Title ?? '', mime)
    } catch (err) {
      throw fromKeyError(err, 'E_BAD_CONTENT_TYPE')
    }
    const { key, dataUri } = await this.allocate(base)
    const created = await this.createNew({
      title: Title?.trim() || DEFAULT_PASTE_TITLE,
      source: null,
      data_uri: dataUri,
      content_type: mime,
      content_hash: hash,
    })
    if (created.hit) return created.hit
    const resource = created.resource

    try {
      await this.store.put(key, bytes, mime)
      return { resource: await this.markUploaded(resource, bytes.length, mime) }
    } catch (err) {
      if (err instanceof ArchiveError) throw err
      return await this.fail(resource, 'E_STORE_FAILED', '写入对象存储失败', err)
    }
  }

  private async findByHash(Hash: string): Promise<ArchivedResource | null> {
    const existing = await this.repo.getResourceByContentHash(Hash)
    if (!existing) return null
    if (existing.deleted_at === null) return { resource: existing, duplicate: true }

    try {
      const restored = await this.restore.restore(existing.id)
      return { resource: restored, restored: true }
    } catch (err) {
      if (err instanceof RestoreError) {
        if (err.code === 'E_NOT_DELETED') {
          const now = await this.repo.getResourceByContentHash(Hash)
          if (now?.deleted_at === null) return { resource: now, duplicate: true }
        }
        throw new ArchiveError('E_ORIGINAL_LOST', err.message, err.resource ?? existing)
      }
      throw err
    }
  }

  private async createNew(Data: {
    title: string
    source: string | null
    data_uri: string
    content_type: string
    content_hash: string
  }): Promise<{ resource: Resource; hit?: undefined } | { resource?: undefined; hit: ArchivedResource }> {
    try {
      const resource = await this.repo.createResource({ ...Data, status: 'uploading' })
      return { resource }
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      const hit = await this.findByHash(Data.content_hash)
      if (hit) return { hit }
      throw err
    }
  }

  private async allocate(BaseKey: string): Promise<{ key: string; dataUri: string }> {
    const key = await allocateKey(BaseKey, async (Candidate) => {
      const dataUri = buildDataUri(this.config.s3Bucket, Candidate)
      if (await this.repo.dataUriExists(dataUri)) return true
      return (await this.store.stat(Candidate)) !== null
    })
    return { key, dataUri: buildDataUri(this.config.s3Bucket, key) }
  }

  private async failedUrl(
    Url: string,
    Title: string | undefined,
    Base: string,
    Code: string,
    Reason: string,
    Cause?: unknown,
  ): Promise<never> {
    const { dataUri } = await this.allocate(Base)
    const resource = await this.repo.createResource({
      title: Title?.trim() || hostnameOf(Url),
      source: Url,
      data_uri: dataUri,
      content_type: 'application/octet-stream',
      status: 'uploading',
    })
    return await this.fail(resource, Code, Reason, Cause)
  }

  private async markUploaded(Resource: Resource, Size: number, Mime: string): Promise<Resource> {
    const ok = await this.repo.markResourceUploaded(Resource.id, Size, Mime)
    if (!ok) throw new ArchiveError('E_RESOURCE_GONE', '资源已删除或状态不允许上传', Resource)
    const updated = await this.repo.getResource(Resource.id)
    if (!updated) throw new ArchiveError('E_RESOURCE_GONE', '资源已删除', Resource)
    return updated
  }

  private async fail(Resource: Resource, Code: string, Reason: string, Cause?: unknown): Promise<never> {
    logError(Code, Reason, {
      resource_id: Resource.id,
      ...(Cause === undefined ? {} : { cause: Cause instanceof Error ? Cause.message : String(Cause) }),
    })
    await this.repo.updateResourceStatus(Resource.id, 'upload_failed', Reason)
      .catch((err) => logError('E_ARCHIVE_MARK', String(err)))
    throw new ArchiveError(Code, Reason, { ...Resource, status: 'upload_failed', error_reason: Reason })
  }
}

function fromKeyError(Err: unknown, Code: string): ArchiveError {
  if (Err instanceof StorageUriError) return new ArchiveError(Code, Err.message)
  return new ArchiveError(Code, Err instanceof Error ? Err.message : String(Err))
}

function normalizeUrlMime(Raw: string | undefined): string | null {
  const mime = (Raw ?? '').split(';', 1)[0]!.trim().toLowerCase()
  if (mime === '' || mime === 'text/html' || mime === 'application/xhtml+xml') return 'text/html'
  if (mime === 'text/markdown' || mime === 'text/plain') return mime
  return null
}

function normalizePasteMime(Raw: string): string | null {
  const mime = Raw.split(';', 1)[0]!.trim().toLowerCase()
  return mime === 'text/markdown' || mime === 'text/plain' ? mime : null
}

function titleFromKey(Key: string): string {
  const name = fileNameFromKey(Key)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function hostnameOf(Url: string): string {
  try {
    return new URL(Url).hostname
  } catch {
    return DEFAULT_URL_TITLE
  }
}

function isUniqueViolation(Err: unknown): boolean {
  return typeof Err === 'object' && Err !== null && (Err as { code?: unknown }).code === '23505'
}
