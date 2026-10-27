/**
 * 资源入库用例 —— 把一条已归档资源交给 ingest 管线：先 stat 原始对象，确认上传完整/类型/大小，再读 data_uri 解析、切块、embed、写库。
 * 同一门禁服务两条入口：文件 PUT 后 confirmUpload 只 stat/验类型/大小并转 uploaded；ingest 通过后由 IngestFactory.runExisting 负责 processing → ready/process_failed。
 * 门禁失败会落 upload_failed、清掉旧 chunks 并带 resource。不做上传、不建行；那些在 ResourceArchive。
 * processing 直接 409；confirmUpload 只接 uploading/uploaded/upload_failed；ingest 还允许 ready/process_failed 重跑（ready 覆盖旧 chunks）。
 */

export { ResourceIngest, IngestGateError }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { AppConfig } from '../config'
import { EmbeddingHandle, ObjectStoreHandle, PostgresRepo } from '../adapter/contract'
import type { Repo, Resource } from '../adapter/contract'
import { IngestFactory } from '../ingest/ingest'
import type { IngestResult, Recipe } from '../ingest/contracts'
import { createDbStageSink } from '../trace/systemtrace/stage-sink'
import { parseDataUri } from '../adapter/storage/uri'
import { logError } from '../trace/systemtrace/log'
import { MAX_RESOURCE_BYTES } from './archive'

class IngestGateError extends Error {
  readonly code: string
  readonly resource: Resource | null

  constructor(Code: string, Message: string, Resource: Resource | null = null) {
    super(Message)
    this.name = 'IngestGateError'
    this.code = Code
    this.resource = Resource
  }
}

const SUPPORTED_MIME = new Set(['text/html', 'text/markdown', 'text/plain'])

@singleton()
class ResourceIngest {
  private readonly config: AppConfig
  private readonly store: ObjectStoreHandle
  private readonly repo: Repo
  private readonly factory: IngestFactory
  private readonly embedding: EmbeddingHandle

  constructor(
    @inject(AppConfig) Config: AppConfig,
    @inject(ObjectStoreHandle) Store: ObjectStoreHandle,
    @inject(PostgresRepo) Repo: Repo,
    @inject(IngestFactory) Factory: IngestFactory,
    @inject(EmbeddingHandle) Embedding: EmbeddingHandle,
  ) {
    this.config = Config
    this.store = Store
    this.repo = Repo
    this.factory = Factory
    this.embedding = Embedding
  }

  async confirmUpload(Id: string): Promise<Resource> {
    const gated = await this.gate(Id, false)
    return gated.resource
  }

  async ingest(Id: string, Chunker: string | undefined): Promise<IngestResult> {
    const gated = await this.gate(Id, true)
    const { resource, expected, stat } = gated

    const chunker = Chunker?.trim() || 'legacy'
    const recipe: Recipe = {
      fetcher: 'storage',
      parser: expected === 'text/html' ? 'html' : 'text',
      chunker,
      embedding: this.embedding,
      repo: this.repo,
    }
    const uploaded = { ...resource, status: 'uploaded' as const, storage_size_bytes: stat.size }
    return await this.factory.assemble(recipe).runExisting(uploaded, { sink: createDbStageSink(this.repo) })
  }

  private async gate(Id: string, AllowReady: boolean): Promise<{ resource: Resource; expected: string; stat: { size: number; contentType: string | null } }> {
    const resource = await this.repo.getResource(Id)
    if (!resource) throw new IngestGateError('E_NOT_FOUND', '资源不存在或已删除')
    if (resource.status === 'processing') throw new IngestGateError('E_ALREADY_PROCESSING', '资源正在入库', resource)
    const Allowed: Resource['status'][] = AllowReady
      ? ['uploading', 'uploaded', 'upload_failed', 'process_failed', 'ready']
      : ['uploading', 'uploaded', 'upload_failed']
    if (!Allowed.includes(resource.status)) {
      throw new IngestGateError('E_NOT_UPLOADING', `资源状态是 ${resource.status}，不能确认上传`, resource)
    }

    let parts: ReturnType<typeof parseDataUri>
    try {
      parts = parseDataUri(resource.data_uri)
    } catch (err) {
      throw new IngestGateError('E_BAD_ORIGINAL', err instanceof Error ? err.message : String(err), resource)
    }
    if (parts.bucket !== this.config.s3Bucket) {
      throw new IngestGateError('E_BAD_ORIGINAL', `data_uri bucket 不匹配: ${parts.bucket}`, resource)
    }

    const expected = normalizeMime(resource.content_type)
    if (expected === null || !SUPPORTED_MIME.has(expected)) {
      await this.deleteOriginal(parts.key, resource.id)
      return await this.failUpload(resource, 'E_UNSUPPORTED_CONTENT_TYPE', `不支持的内容类型: ${resource.content_type}`)
    }

    const stat = await this.store.stat(parts.key)
    if (!stat) return await this.failUpload(resource, 'E_UPLOAD_INCOMPLETE', '原始对象不存在')
    if (stat.size === 0) {
      await this.deleteOriginal(parts.key, resource.id)
      return await this.failUpload(resource, 'E_UPLOAD_EMPTY', '原始对象为空')
    }
    if (stat.size > MAX_RESOURCE_BYTES) {
      await this.deleteOriginal(parts.key, resource.id)
      return await this.failUpload(resource, 'E_UPLOAD_TOO_LARGE', `原始对象超过 ${MAX_RESOURCE_BYTES} 字节`)
    }
    const actual = normalizeMime(stat.contentType ?? '')
    if (actual !== expected) {
      await this.deleteOriginal(parts.key, resource.id)
      return await this.failUpload(resource, 'E_UPLOAD_TYPE_MISMATCH', `对象类型 ${stat.contentType ?? '空'} 与资源 ${resource.content_type} 不一致`)
    }

    const marked = await this.repo.markResourceUploaded(resource.id, stat.size, resource.content_type)
    if (!marked) throw new IngestGateError('E_RESOURCE_GONE', '资源已删除或状态不允许入库', resource)
    const current = await this.repo.getResource(Id)
    if (!current) throw new IngestGateError('E_RESOURCE_GONE', '资源在确认上传期间被删除', resource)
    return { resource: current, expected, stat }
  }

  private async deleteOriginal(Key: string, ResourceId: string): Promise<void> {
    try {
      await this.store.delete(Key)
    } catch (err) {
      logError('E_ORIGINAL_DELETE', String(err), { resource_id: ResourceId })
    }
  }

  private async failUpload(Resource: Resource, Code: string, Reason: string): Promise<never> {
    // 重入库的 ready 行可能还挂着上一批 chunks；门禁失败也不能把它们留在检索里
    await this.repo.deleteChunksByResource(Resource.id)
      .catch((err) => logError('E_UPLOAD_CLEAN', String(err)))
    await this.repo.updateResourceStatus(Resource.id, 'upload_failed', Reason)
      .catch((err) => logError('E_UPLOAD_MARK', String(err)))
    throw new IngestGateError(Code, Reason, { ...Resource, status: 'upload_failed', error_reason: Reason })
  }
}

function normalizeMime(Raw: string): string | null {
  const mime = Raw.split(';', 1)[0]!.trim().toLowerCase()
  return mime === '' ? null : mime
}
