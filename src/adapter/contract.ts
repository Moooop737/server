/**
 * 基础层唯一的对外门 —— 别盒只准从这里 import（AD-6：adapter/ 用单一 contract.ts 门，不逐盒建）。
 * 门只交服务、不交连接：DbHandle 造池，PostgresRepo 持有池与 Drizzle 实例；Pool 与 SQL 文本仍不出 repo/（AD-3），
 * 所以这里不出现 `pg`，也没有「借一条连接」的原语可导出。
 * Repo 按用例分组：资源/分块、会话/消息、检索候选、trace 写入；CRUD 的 HTTP 投影由 routes/crud.ts 统一注册 hono-crud。
 * ChunkCandidate 就是检索命中去掉名次分那一位 —— score 由融合侧产出，不该由基础层造，
 * 所以两条候选查询交出 ChunkCandidate，retrieve/search/ 的两个适配器补上 score: 0 再交给 Retriever。
 * EmbeddingHandle 与 ChatHandle 是句柄选择位，都是 @singleton() 类：各自拿 AppConfig 的名字（EMBEDDING_MODEL / CHAT_MODEL）去 ModelRegistry 的两张表里兑换那一行，名字不在册就当场点名退出（E_EMBEDDING_MODEL / E_CHAT_MODEL）—— 选择与校验住在同一个构造里，别处不再自己做这个名字兑换，也不再拿 ! 兜住查不到的情况。
 * EmbeddingHandle 交出的是三位（句柄 + 写进 embeddings.model 的标识 + 本次要截到几维），ChatHandle 只交句柄；
 * 维度不进 model 表 —— SDK 句柄没有 dimensions 位，它是调用选项，env 的 EMBEDDING_DIMENSIONS 才是它的来源。
 * 三个 Ollama 探针是原生只读 HTTP（/api/version、/api/tags、/api/ps），不是 SDK，只是服务商接入的一部分。
 * SDK 这几格交的都是 @singleton() 类：new ModelRegistry() 内部调 providerRegistry()（按 env 里在位的 Key 造服务商，缺 Key 不进表、不报错）再兑换成句柄。
 * providerRegistry 不再出门：它只是 ModelRegistry 构造里的一步，外面要句柄就取 ModelRegistry，取不到两份 provider 表。
 * 两者都只在装配期各调一次，句柄身份因此进程级唯一；providers 这层中间产物不出门，外面只见 models。
 * 方法级前置条件（调用方只读这一份，不必开 repo/ 各文件）：
 * · writeChunksWithEmbeddings：Vectors 与 Chunks 同序等长（由调用方 ingest 判长度）；chunk、向量、转 ready 同一事务，
 *   不存在「向量已落、行还 processing」；返回写入 chunk 数；期间资源被软删则整笔回滚并抛 code='E_RESOURCE_GONE'。
 * · findActiveBySource：只认 status ∈ ready/processing 且未软删。
 * · softDeleteResource：resources 留痕、chunks 物理删（embeddings 经 FK source_id→chunks.id ON DELETE CASCADE 随之消失）；
 *   返回 false = 该行不存在或早已软删。
 * · dimensionsInStore：数的是 embeddings 的维度事实，与行是否软删无关；库不可达时抛，由调用方处置（检索层每请求现查一次，见 retrieve/retrievers.ts）。
 * · updateResourceStatus / 写入路径都自带 `deleted_at IS NULL` 谓词，不由调用方拼。
 * · trace 两条只写 traces 公共行；insert/finish 失败不影响业务，吞错与日志归调用方（见 trace/systemtrace/endpoint.ts）。
 * 唯一例外：`connection/pool.ts` 的 createDbPool 被三个 gitignore 的对账脚本直接 import（它们要一条独立连接做 raw 校数），不经本门。
 * 本层的四格分工：`connection/`＝怎么连上外部服务（pg 池、Ollama 的原生地址与探活），`repo/`＝按功能分的行、SQL 与实体形状（resource.ts / chunk.ts / session.ts / message.ts / trace.ts / search-*.ts），`provider/`＋`model/`＝AI SDK 的网关、句柄与 embed 调用封装。
 * `repo/orm/`＝Drizzle schema 与实例（只覆盖四张 CRUD 表）；BM25/向量仍走 `repo/search-*.ts` 的裸 SQL。
 * 唯一例外：四张 Drizzle 表经本门交给 routes/crud.ts 的 hono-crud 注册（需要表与 model metadata）。
 * 实体形状不再有跨层共享盒（原 `types/` 已删）：别盒要用哪一位，由本门逐个点名交出（现交 Resource 与四张 Drizzle 表）。
 */

export {RetrieverHandle, PostgresRepo, EmbeddingHandle, ChatHandle, ObjectStoreHandle, ollamaHealthCheck, ollamaModelList, ollamaStatusList, embedChunks }
export { resources, sessions, messages, traces } from './repo/orm/schema'
export { listChatSessions, listChatTraces, getChatTrace } from './repo/observability'
export { ObjectStoreError } from './storage/object-store'
export type { Repo, ChunkCandidate, Resource, Message, Trace, TraceStage, TraceStageInput, TracePayloads, TracePayloadOmitReason, RegistedProviders, RegistedModels }
export type { ChatSessionSummary, ChatTraceSummary } from './repo/observability'
export type { ObjectStore, ObjectStat, ObjectBody, ObjectGetOptions, ObjectPresignOptions, ObjectPresignPutOptions } from './storage/object-store'

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { pingDb } from './connection/pool'
import { DbHandle } from './connection/db'
import { createOrm } from './repo/orm/client'
import {
  createResource, updateResourceStatus, updateResourceTitle, softDeleteResource, markInterruptedAsFailed,
  getResource, findActiveBySource, resourceCounts,
} from './repo/resource'
import { writeChunksWithEmbeddings, deleteChunksByResource, getChunksPage } from './repo/chunk'
import { dimensionsInStore, vectorCandidates } from './repo/search-vector'
import { lexicalCandidates } from './repo/search-lexical'
import { insertTrace, finishTrace, setTraceSession, setTraceResource, getTrace, insertTraceStage, listTraceStages } from './repo/trace'
import { listChatSessions, listChatTraces, getChatTrace } from './repo/observability'
import { getSession } from './repo/session'
import { createMessage, getMessagesBySession } from './repo/message'
import { ollamaHealthCheck, ollamaModelList, ollamaStatusList } from './connection/ollama'
import { type ProviderEntryName } from './provider/registry'
import { ModelRegistry, type EmbeddingModelId, type LanguageModelId } from './model/registry'
import { embedChunks } from './model/embed-chunks'
import { createS3Client, putObject, statObject, getObject, deleteObject, presignGet, presignPut, pingBucket, ensureBucket } from './storage/s3'
import type { ObjectStore, ObjectGetOptions, ObjectPresignOptions, ObjectPresignPutOptions } from './storage/object-store'

import { AppConfig } from '../config'
import { logError } from '../trace/systemtrace/log'
import type { Resource, ResourceCounts } from './repo/resource'
import type { Chunk, Embedding } from './repo/chunk'
import type { Session } from './repo/session'
import type { Message } from './repo/message'
import type { ChatSessionSummary, ChatTraceSummary } from './repo/observability'
import type { Orm } from './repo/orm/client'
import type { TraceStart, TraceFinish, TracePayloads, TracePayloadOmitReason, Trace, TraceStage, TraceStageInput } from './repo/trace'
import type { EmbeddingModelV4, LanguageModelV4, ProviderV4 } from '@ai-sdk/provider';
import type { Retriever, RetrieverRecipe } from '../retrieve/contracts';
import { RetrieverFactory } from '../retrieve/retrievers';
import { RETRIEVER_RECIPE_NAMES } from '../retrieve/recipes';

interface Repo {
  ping(): Promise<boolean>
  dimensionsInStore(): Promise<number[]>
  markInterruptedAsFailed(): Promise<{ resources: number }>
  vectorCandidates(QueryVector: number[], Limit: number, Dim: number): Promise<ChunkCandidate[]>
  lexicalCandidates(QueryText: string, Limit: number): Promise<ChunkCandidate[]>

  createResource(
    Data: Pick<Resource, 'title' | 'source' | 'data_uri' | 'content_type'> & Partial<Pick<Resource, 'status'>>,
  ): Promise<Resource>
  getResource(Id: string): Promise<Resource | null>
  resourceCounts(): Promise<ResourceCounts>
  updateResourceStatus(Id: string, Status: Resource['status'], Reason?: string): Promise<void>
  updateResourceTitle(Id: string, Title: string): Promise<void>
  findActiveBySource(Url: string): Promise<Resource | null>
  softDeleteResource(Id: string): Promise<boolean>

  writeChunksWithEmbeddings(
    ResourceId: string,
    Chunks: Pick<Chunk, 'chunk_index' | 'content' | 'start_offset' | 'end_offset'>[],
    Vectors: Pick<Embedding, 'dimension' | 'model' | 'embedding'>[],
  ): Promise<number>
  getChunksPage(ResourceId: string, Offset: number, Limit: number, Search: string): Promise<{ Items: Chunk[]; TotalCount: number }>
  deleteChunksByResource(ResourceId: string): Promise<void>

  getSession(Id: string): Promise<Session | null>
  createMessage(Data: Pick<Message, 'session_id' | 'role' | 'content' | 'parts'>): Promise<Message>
  getMessagesBySession(SessionId: string): Promise<Message[]>

  insertTrace(Entry: TraceStart): Promise<void>
  finishTrace(TraceId: string, Finish: TraceFinish): Promise<void>
  setTraceSession(TraceId: string, SessionId: string): Promise<void>
  setTraceResource(TraceId: string, ResourceId: string): Promise<void>
  getTrace(TraceId: string): Promise<Trace | null>
  insertTraceStage(TraceId: string, Stage: TraceStageInput): Promise<void>
  listTraceStages(TraceId: string): Promise<TraceStage[]>

  listChatSessions(Offset: number, Limit: number): Promise<{ Items: ChatSessionSummary[]; TotalCount: number }>
  listChatTraces(SessionId: string | null, Offset: number, Limit: number): Promise<{ Items: ChatTraceSummary[]; TotalCount: number }>
  getChatTrace(TraceId: string): Promise<ChatTraceSummary | null>
}

interface ChunkCandidate {
  chunk: Chunk
  docTitle: string
  source: string | null
  dataUri: string
  similarity: number | null
  lexicalScore: number | null
}

@singleton()
class EmbeddingHandle {
  readonly model: EmbeddingModelV4
  readonly modelId: string
  readonly dimensions: number

  constructor(@inject(AppConfig) Config: AppConfig, @inject(ModelRegistry) Models: RegistedModels) {
    const Name = Config.embeddingModel
    if (!Object.hasOwn(Models.embeddingModels, Name)) {
      logError('E_EMBEDDING_MODEL', `EMBEDDING_MODEL=${Name} 不在册；在册嵌入句柄=${Object.keys(Models.embeddingModels).join(',') || '无'}`)
      process.exit(1)
    }
    this.model = Models.embeddingModels[Name as EmbeddingModelId]!
    this.modelId = Name
    this.dimensions = Config.embeddingDimensions
  }
}

@singleton()
class ChatHandle {
  readonly model: LanguageModelV4

  constructor(@inject(AppConfig) Config: AppConfig, @inject(ModelRegistry) Models: RegistedModels) {
    const Name = Config.chatModel
    if (!Object.hasOwn(Models.languageModels, Name)) {
      logError('E_CHAT_MODEL', `CHAT_MODEL=${Name} 不在册；在册对话句柄=${Object.keys(Models.languageModels).join(',') || '无'}`)
      process.exit(1)
    }
    this.model = Models.languageModels[Name as LanguageModelId]!
  }
}

@singleton()
class PostgresRepo implements Repo {
  private readonly db: DbHandle['pool']
  readonly orm: Orm

  constructor(@inject(DbHandle) Db: DbHandle) {
    this.db = Db.pool
    this.orm = createOrm(this.db)
  }

  ping() {
    return pingDb(this.db)
  }

  dimensionsInStore() {
    return dimensionsInStore(this.db)
  }

  markInterruptedAsFailed() {
    return markInterruptedAsFailed(this.db)
  }

  vectorCandidates(QueryVector: number[], Limit: number, Dim: number) {
    return vectorCandidates(this.db, QueryVector, Limit, Dim)
  }

  lexicalCandidates(QueryText: string, Limit: number) {
    return lexicalCandidates(this.db, QueryText, Limit)
  }

  createResource(
    Data: Pick<Resource, 'title' | 'source' | 'data_uri' | 'content_type'> & Partial<Pick<Resource, 'status'>>,
  ) {
    return createResource(this.db, Data)
  }

  getResource(Id: string) {
    return getResource(this.orm, Id)
  }

  resourceCounts() {
    return resourceCounts(this.db)
  }

  updateResourceStatus(Id: string, Status: Resource['status'], Reason?: string) {
    return updateResourceStatus(this.db, Id, Status, Reason)
  }

  updateResourceTitle(Id: string, Title: string) {
    return updateResourceTitle(this.db, Id, Title)
  }

  findActiveBySource(Url: string) {
    return findActiveBySource(this.db, Url)
  }

  softDeleteResource(Id: string) {
    return softDeleteResource(this.db, Id)
  }

  writeChunksWithEmbeddings(
    ResourceId: string,
    Chunks: Pick<Chunk, 'chunk_index' | 'content' | 'start_offset' | 'end_offset'>[],
    Vectors: Pick<Embedding, 'dimension' | 'model' | 'embedding'>[],
  ) {
    return writeChunksWithEmbeddings(this.db, ResourceId, Chunks, Vectors)
  }

  getChunksPage(ResourceId: string, Offset: number, Limit: number, Search: string) {
    return getChunksPage(this.db, ResourceId, Offset, Limit, Search)
  }

  deleteChunksByResource(ResourceId: string) {
    return deleteChunksByResource(this.db, ResourceId)
  }

  getSession(Id: string) {
    return getSession(this.db, Id)
  }

  createMessage(Data: Pick<Message, 'session_id' | 'role' | 'content' | 'parts'>) {
    return createMessage(this.db, Data)
  }

  getMessagesBySession(SessionId: string) {
    return getMessagesBySession(this.db, SessionId)
  }

  insertTrace(Entry: TraceStart) {
    return insertTrace(this.db, Entry)
  }

  finishTrace(TraceId: string, Finish: TraceFinish) {
    return finishTrace(this.db, TraceId, Finish)
  }

  setTraceSession(TraceId: string, SessionId: string) {
    return setTraceSession(this.db, TraceId, SessionId)
  }

  setTraceResource(TraceId: string, ResourceId: string) {
    return setTraceResource(this.db, TraceId, ResourceId)
  }

  getTrace(TraceId: string) {
    return getTrace(this.db, TraceId)
  }

  insertTraceStage(TraceId: string, Stage: TraceStageInput) {
    return insertTraceStage(this.db, TraceId, Stage)
  }

  listTraceStages(TraceId: string) {
    return listTraceStages(this.db, TraceId)
  }

  listChatSessions(Offset: number, Limit: number) {
    return listChatSessions(this.db, Offset, Limit)
  }

  listChatTraces(SessionId: string | null, Offset: number, Limit: number) {
    return listChatTraces(this.db, SessionId, Offset, Limit)
  }

  getChatTrace(TraceId: string) {
    return getChatTrace(this.db, TraceId)
  }
}

@singleton()
class ObjectStoreHandle implements ObjectStore {
  private readonly client: ReturnType<typeof createS3Client>
  private readonly bucket: string

  constructor(@inject(AppConfig) Config: AppConfig) {
    this.client = createS3Client({
      endpoint: Config.s3Endpoint,
      region: Config.s3Region,
      forcePathStyle: Config.s3ForcePathStyle,
      accessKeyId: Config.s3AccessKeyId,
      secretAccessKey: Config.s3SecretAccessKey,
    })
    this.bucket = Config.s3Bucket
  }

  put(Key: string, Body: Uint8Array, ContentType: string) {
    return putObject(this.client, this.bucket, Key, Body, ContentType)
  }

  stat(Key: string) {
    return statObject(this.client, this.bucket, Key)
  }

  get(Key: string, Options?: ObjectGetOptions) {
    return getObject(this.client, this.bucket, Key, Options)
  }

  delete(Key: string) {
    return deleteObject(this.client, this.bucket, Key)
  }

  presignGet(Key: string, Options: ObjectPresignOptions) {
    return presignGet(this.client, this.bucket, Key, Options)
  }

  presignPut(Key: string, Options: ObjectPresignPutOptions) {
    return presignPut(this.client, this.bucket, Key, Options)
  }

  ping() {
    return pingBucket(this.client, this.bucket)
  }

  ensureBucket() {
    return ensureBucket(this.client, this.bucket)
  }
}

@singleton()
class RetrieverHandle {
  readonly retriever: Retriever

  constructor(
    @inject(RetrieverFactory) Factory: RetrieverFactory,
    @inject(PostgresRepo) Repo: Repo,
    @inject(EmbeddingHandle) Embedding: EmbeddingHandle,
    @inject(AppConfig) Config: AppConfig,
  ) {
    const recipe: RetrieverRecipe = {
      ...RETRIEVER_RECIPE_NAMES,
      deps: { repo: Repo, embedding: Embedding, config: Config },
    }
    this.retriever = Factory.assemble(recipe)
  }
}

type RegistedProviders = Partial<Record<ProviderEntryName, ProviderV4>>

type RegistedModels = {
  languageModels: Partial<Record<LanguageModelId, LanguageModelV4>>
  embeddingModels: Partial<Record<EmbeddingModelId, EmbeddingModelV4>>
}
