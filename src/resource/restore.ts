/**
 * 软删恢复 —— 只接 deleted_at 非空的行；先确认 data_uri 指向的对象还在，再清 deleted_at 回 uploaded。
 * 恢复不自动 ingest：路由返回 uploaded 资源，调用方再走 /resources/:id/ingest。
 * 原对象不存在/旧 URI/bucket 不一致时保持软删，报 E_NO_ORIGINAL；active 行报 E_NOT_DELETED。
 */

export { ResourceRestore, RestoreError }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { AppConfig } from '../config'
import { ObjectStoreHandle, PostgresRepo } from '../adapter/contract'
import type { Repo, Resource } from '../adapter/contract'
import { parseDataUri } from '../adapter/storage/uri'

class RestoreError extends Error {
  readonly code: string
  readonly resource: Resource | null

  constructor(Code: string, Message: string, Resource: Resource | null = null) {
    super(Message)
    this.name = 'RestoreError'
    this.code = Code
    this.resource = Resource
  }
}

@singleton()
class ResourceRestore {
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

  async restore(Id: string): Promise<Resource> {
    const resource = await this.repo.getResourceIncludingDeleted(Id)
    if (!resource) throw new RestoreError('E_NOT_FOUND', '资源不存在')
    if (resource.deleted_at === null) throw new RestoreError('E_NOT_DELETED', '资源未删除，无需恢复', resource)

    let parts: ReturnType<typeof parseDataUri>
    try {
      parts = parseDataUri(resource.data_uri)
    } catch {
      throw new RestoreError('E_NO_ORIGINAL', '原始文件不存在或 data_uri 不是 kc:// URI', resource)
    }
    if (parts.bucket !== this.config.s3Bucket) {
      throw new RestoreError('E_NO_ORIGINAL', 'data_uri bucket 与当前桶不一致', resource)
    }

    const stat = await this.store.stat(parts.key)
    if (!stat) throw new RestoreError('E_NO_ORIGINAL', '原始文件不存在，无法恢复', resource)

    const restored = await this.repo.restoreResource(Id)
    if (!restored) throw new RestoreError('E_NOT_DELETED', '资源未删除或状态已变化', resource)

    const marked = await this.repo.markResourceUploaded(restored.id, stat.size, restored.content_type)
    if (!marked) throw new RestoreError('E_RESOURCE_GONE', '资源在恢复期间被删除', restored)
    const current = await this.repo.getResource(Id)
    if (!current) throw new RestoreError('E_RESOURCE_GONE', '资源在恢复期间被删除', restored)
    return current
  }
}
