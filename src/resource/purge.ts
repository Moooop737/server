/**
 * 彻底删除 —— 只接软删行。先幂等删 data_uri 指向的 MinIO 对象，再删 resources 行；
 * chunks/embeddings 随外键 CASCADE，content_hash 随行释放，之后同内容可以重新上传。
 * 对象已经丢失允许清行；data_uri 不是当前桶的 kc:// URI 时跳过对象删除、只清行。
 * 对象删除失败则保留行并报 E_PURGE_STORE，调用方可重试：顺序固定为先对象后行，避免留下孤儿对象。
 */

export { ResourcePurge, PurgeError }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { AppConfig } from '../config'
import { ObjectStoreHandle, PostgresRepo } from '../adapter/contract'
import type { Repo, Resource } from '../adapter/contract'
import { parseDataUri } from '../adapter/storage/uri'
import { logWarn } from '../trace/systemtrace/log'

class PurgeError extends Error {
  readonly code: string
  readonly resource: Resource | null

  constructor(Code: string, Message: string, Resource: Resource | null = null) {
    super(Message)
    this.name = 'PurgeError'
    this.code = Code
    this.resource = Resource
  }
}

@singleton()
class ResourcePurge {
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

  async purge(Id: string): Promise<void> {
    const resource = await this.repo.getResourceIncludingDeleted(Id)
    if (!resource) throw new PurgeError('E_NOT_FOUND', '资源不存在')
    if (resource.deleted_at === null) throw new PurgeError('E_NOT_DELETED', '只能彻底删除回收站里的资源', resource)

    let key: string | null = null
    try {
      const parts = parseDataUri(resource.data_uri)
      if (parts.bucket === this.config.s3Bucket) key = parts.key
      else logWarn('E_PURGE_ORIGINAL', 'data_uri bucket 与当前桶不一致，跳过对象删除', { resource_id: resource.id })
    } catch {
      logWarn('E_PURGE_ORIGINAL', 'data_uri 不是 kc:// URI，跳过对象删除', { resource_id: resource.id })
    }

    if (key !== null) {
      try {
        await this.store.delete(key)
      } catch (err) {
        throw new PurgeError('E_PURGE_STORE', '删除原始对象失败，资源行保留', resource)
      }
    }

    if (await this.repo.purgeResource(Id)) return
    const now = await this.repo.getResourceIncludingDeleted(Id)
    if (now === null) return
    throw new PurgeError('E_NOT_DELETED', '资源已恢复，不能彻底删除', now)
  }
}
