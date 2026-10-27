/**
 * 原始文件下载 —— 按资源 data_uri 找到对象，签一个短时 presigned GET 给路由做 302。
 * 只读 active 资源；对象不存在/旧 URI/bucket 不一致统一 E_NO_ORIGINAL。
 * 响应内容强制 attachment + 资源 MIME + no-store；文件名取对象 key 的最后一段。
 */

export { ResourceDownload, DownloadError }
export type { OriginalTarget }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { AppConfig } from '../config'
import { ObjectStoreHandle, PostgresRepo } from '../adapter/contract'
import type { Repo, Resource } from '../adapter/contract'
import { fileNameFromKey, parseDataUri } from '../adapter/storage/uri'
import { attachmentDisposition } from '../adapter/storage/disposition'

interface OriginalTarget {
  url: string
  fileName: string
  contentType: string
}

class DownloadError extends Error {
  readonly code: string
  readonly resource: Resource | null

  constructor(Code: string, Message: string, Resource: Resource | null = null) {
    super(Message)
    this.name = 'DownloadError'
    this.code = Code
    this.resource = Resource
  }
}

const PRESIGN_TTL_SECONDS = 3600

@singleton()
class ResourceDownload {
  private readonly config: AppConfig
  private readonly store: ObjectStoreHandle
  private readonly repo: Repo

  constructor(
    @inject(AppConfig) Config: AppConfig,
    @inject(ObjectStoreHandle) Store: ObjectStoreHandle,
    @inject(PostgresRepo) Repo: Repo,
  ) {
    this.config = Config
    this.store = Store
    this.repo = Repo
  }

  async original(Id: string): Promise<OriginalTarget> {
    const resource = await this.repo.getResource(Id)
    if (!resource) throw new DownloadError('E_NOT_FOUND', '资源不存在或已删除')

    let parts: ReturnType<typeof parseDataUri>
    try {
      parts = parseDataUri(resource.data_uri)
    } catch {
      throw new DownloadError('E_NO_ORIGINAL', '原始文件不存在或 data_uri 不是 kc:// URI', resource)
    }
    if (parts.bucket !== this.config.s3Bucket) {
      throw new DownloadError('E_NO_ORIGINAL', 'data_uri bucket 与当前桶不一致', resource)
    }

    const stat = await this.store.stat(parts.key)
    if (!stat) throw new DownloadError('E_NO_ORIGINAL', '原始文件不存在', resource)

    const fileName = fileNameFromKey(parts.key) || 'download'
    const contentType = resource.content_type || stat.contentType || 'application/octet-stream'
    try {
      const url = await this.store.presignGet(parts.key, {
        expiresIn: PRESIGN_TTL_SECONDS,
        responseContentDisposition: attachmentDisposition(fileName),
        responseContentType: contentType,
        responseCacheControl: 'no-store',
      })
      return { url, fileName, contentType }
    } catch {
      throw new DownloadError('E_PRESIGN_FAILED', '生成下载地址失败', resource)
    }
  }
}
