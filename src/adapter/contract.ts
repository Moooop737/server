/**
 * 基础层唯一的对外门 —— 别盒只准从这里 import（AD-6：adapter/ 用单一 contract.ts 门，不逐盒建）。
 * 门只交服务、不交连接：DbHandle 造池，PostgresRepo 持有池与 Drizzle 实例；Pool 与 SQL 文本仍不出 repo/（AD-3），
 * 所以这里不出现 `pg`，也没有「借一条连接」的原语可导出。
 * Repo 按用例分组：资源/分块、会话/消息、检索候选、trace 写入、评测题集/配置；CRUD 的 HTTP 投影由 routes/crud.ts 统一注册 hono-crud。
 * EvalPostgresRepo 是同一套 Repo 方法换评测库的池（继承 PostgresRepo）；只在隔离模式构造，共享模式评测世界直接用 PostgresRepo。
 * Codebases 是独立领域：PostgresCodebaseRepo 只交 CodebaseRepo 接口，不复用 Repo 的资源方法，也不进 hono-crud。
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
 * · findActiveBySource：只认 status ∈ uploading/uploaded/processing/ready 且未软删。
 * · softDeleteResource：resources 留痕、chunks 物理删（embeddings 经 FK source_id→chunks.id ON DELETE CASCADE 随之消失）；
 *   返回 false = 该行不存在或早已软删。
 * · markResourceUploaded：对象已 stat 后确认大小，从 uploading/uploaded/upload_failed/process_failed/ready 转 uploaded（后两者是重试入口）。
 * · restoreResource：只接软删行，清 deleted_at 后回到 uploaded；不是软删行返回 null。
 * · markStaleOnBoot：processing → process_failed，超过 24h 的 uploading → upload_failed。
 * · dimensionsInStore：数的是 embeddings 的维度事实，与行是否软删无关；库不可达时抛，由调用方处置（检索层每请求现查一次，见 retrieve/retrievers.ts）。
 * · updateResourceStatus / 写入路径都自带 `deleted_at IS NULL` 谓词，不由调用方拼。
 * · trace 两条只写 traces 公共行；insert/finish 失败不影响业务，吞错与日志归调用方（见 trace/systemtrace/endpoint.ts）。
 * 唯一例外：`connection/pool.ts` 的 createDbPool 被三个 gitignore 的对账脚本直接 import（它们要一条独立连接做 raw 校数），不经本门。
 * 本层的四格分工：`connection/`＝怎么连上外部服务（pg 池、Ollama 的原生地址与探活），`repo/`＝按功能分的行、SQL 与实体形状（resource.ts / chunk.ts / session.ts / message.ts / trace.ts / search-*.ts），`provider/`＋`model/`＝AI SDK 的网关、句柄与 embed 调用封装。
 * `repo/orm/`＝Drizzle schema 与实例（只覆盖四张 CRUD 表）；BM25/向量仍走 `repo/search-*.ts` 的裸 SQL。
 * 唯一例外：四张 Drizzle 表经本门交给 routes/crud.ts 的 hono-crud 注册（需要表与 model metadata）。
 * 实体形状不再有跨层共享盒（原 `types/` 已删）：别盒要用哪一位，由本门逐个点名交出（现交 Resource 与四张 Drizzle 表）。
 */

export { RetrieverHandle, PostgresRepo, EvalPostgresRepo, PostgresCodebaseRepo, PostgresConfigRepo, EmbeddingHandle, ChatHandle, ObjectStoreHandle, ollamaHealthCheck, ollamaModelList, ollamaStatusList, embedChunks }
export { resources, sessions, messages, traces } from './repo/orm/schema'
export { listChatSessions, getChatTrace, getSessionTranscript } from './repo/observability'
export { ObjectStoreError } from './storage/object-store'
export type { Repo, CodebaseRepo, ChunkCandidate, Resource, ResourceStatus, ResourceCounts, Message, Trace, TraceStage, TraceStageInput, TracePayloads, TracePayloadOmitReason, RegistedProviders, RegistedModels }
export type { ProviderKind, ModelKind, ProviderRow, ModelWithProvider, DefaultRow, ConfigSnapshot, CreateProviderInput, CreateModelInput, UpdateModelInput } from './repo/config'
export type { EvalDataset, EvalCase, EvalGold, EvalAssertion, EvalAssertions, EvalConfig, EvalConfigKind, EvalCaseInput } from './repo/eval'
export type { EvalRun, EvalRunStatus, EvalRunSnapshot, EvalRunCaseSnapshot, EvalRunResult, EvalHumanResult, EvalVerdict, EvalAssertionCheck, EvalAssertionResult, EvalJudgeResult, EvalCitation } from './repo/eval-run'
export type { Codebase, CodebaseSummary, CodebaseEntry, CodebaseStatus } from './repo/codebase'
export type { ChatSessionSummary, ChatTraceSummary, ChatTurn, TranscriptMessage } from './repo/observability'
export type { ObjectStore, ObjectStat, ObjectBody, ObjectGetOptions, ObjectPresignOptions, ObjectPresignPutOptions } from './storage/object-store'

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { pingDb } from './connection/pool'
import { DbHandle } from './connection/db'
import { EvalDbHandle } from './connection/eval-db'
import { createOrm } from './repo/orm/client'
import {
  createResource, updateResourceStatus, updateResourceTitle, softDeleteResource, markResourceUploaded, restoreResource,
  getResource, getResourceIncludingDeleted, getResourceByContentHash, findActiveBySource, dataUriExists, resourceCounts, markStaleOnBoot,
  listDeletedResources, purgeResource, listResourcesByUriSuffix, searchResources,
} from './repo/resource'
import {
  createCodebase, getCodebase, getCodebaseSummary, listCodebases, updateCodebaseStatus, markCodebaseReady, deleteCodebase,
  codebaseDataUriExists, markStaleCodebases,
} from './repo/codebase'
import { writeChunksWithEmbeddings, deleteChunksByResource, getChunksPage, getChunkByIndex, listChunksByResource } from './repo/chunk'
import { dimensionsInStore, vectorCandidates } from './repo/search-vector'
import { lexicalCandidates } from './repo/search-lexical'
import { insertTrace, finishTrace, setTraceSession, setTraceResource, getTrace, insertTraceStage, listTraceStages } from './repo/trace'
import { listChatSessions, getChatTrace, getSessionTranscript } from './repo/observability'
import { getSession } from './repo/session'
import { createMessage, getMessagesBySession } from './repo/message'
import {
  listDatasets, getDataset, createDataset, updateDataset, setDatasetBaseline, countRunsOfDataset, deleteDataset, duplicateDataset,
  listCases, getCase, createCase, updateCase, deleteCase, nextCaseKey, upsertCase,
  listConfigs, getConfig, createConfig, updateConfig, deleteConfig, duplicateConfig,
} from './repo/eval'
import {
  createRun, getRun, listRuns, appendRunResult, setHumanResult, startRun, finishRun, cancelQueuedRun,
  markInterruptedRuns, deleteRun, getChunkByDataUri,
} from './repo/eval-run'
import {
  listProviders, getProvider, getProviderByName, createProvider,
  setProviderBaseUrl, setProviderEnabled, setProviderApiKey, setProviderHeaders, setProviderQuery, setProviderOptions, deleteProvider,
  listModels, getModel, createModel, updateModel, deleteModel,
  listDefaults, getDefault, upsertDefault, deleteDefault, readConfig,
} from './repo/config'
import type { CreateProviderInput, CreateModelInput, UpdateModelInput } from './repo/config'
import { ollamaHealthCheck, ollamaModelList, ollamaStatusList } from './connection/ollama'
import { type ProviderEntryName } from './provider/registry'
import { ModelRegistry, type EmbeddingModelId, type LanguageModelId } from './model/registry'
import { modelIdOf } from './model/key'
import { embedChunks } from './model/embed-chunks'
import { createS3Client, putObject, statObject, getObject, deleteObject, presignGet, presignPut, pingBucket, ensureBucket } from './storage/s3'
import type { ObjectStore, ObjectGetOptions, ObjectPresignOptions, ObjectPresignPutOptions } from './storage/object-store'

import { AppConfig } from '../config'
import { logError } from '../trace/systemtrace/log'
import type { Resource, ResourceStatus, ResourceCounts } from './repo/resource'
import type { Codebase, CodebaseSummary, CodebaseEntry, CodebaseStatus } from './repo/codebase'
import type { Chunk, Embedding } from './repo/chunk'
import type { Session } from './repo/session'
import type { Message } from './repo/message'
import type { ChatSessionSummary, ChatTraceSummary, ChatTurn } from './repo/observability'
import type { Orm } from './repo/orm/client'
import type { EvalDataset, EvalCase, EvalConfig, EvalConfigKind, EvalCaseInput } from './repo/eval'
import type { EvalRun, EvalRunSnapshot, EvalRunResult, EvalHumanResult } from './repo/eval-run'
import type { TraceStart, TraceFinish, TracePayloads, TracePayloadOmitReason, Trace, TraceStage, TraceStageInput } from './repo/trace'
import type { EmbeddingModelV4, LanguageModelV4, ProviderV4 } from '@ai-sdk/provider';
import type { Retriever, RetrieverRecipe } from '../retrieve/contracts';
import { RetrieverFactory } from '../retrieve/retrievers';
import { RETRIEVER_RECIPE_NAMES } from '../retrieve/recipes';

interface Repo {
  ping(): Promise<boolean>
  dimensionsInStore(): Promise<number[]>
  markStaleOnBoot(): Promise<{ resources: number; uploads: number }>
  vectorCandidates(QueryVector: number[], Limit: number, Dim: number): Promise<ChunkCandidate[]>
  lexicalCandidates(QueryText: string, Limit: number): Promise<ChunkCandidate[]>

  createResource(
    Data: Pick<Resource, 'title' | 'source' | 'data_uri' | 'content_type' | 'status'>
      & Partial<Pick<Resource, 'storage_size_bytes' | 'content_hash'>>,
  ): Promise<Resource>
  getResource(Id: string): Promise<Resource | null>
  getResourceIncludingDeleted(Id: string): Promise<Resource | null>
  getResourceByContentHash(Hash: string): Promise<Resource | null>
  listDeletedResources(Offset: number, Limit: number, Search: string, Sort?: string, Order?: 'asc' | 'desc'): Promise<{ Items: Resource[]; TotalCount: number }>
  purgeResource(Id: string): Promise<Resource | null>
  resourceCounts(): Promise<ResourceCounts>
  updateResourceStatus(Id: string, Status: ResourceStatus, Reason?: string): Promise<void>
  updateResourceTitle(Id: string, Title: string): Promise<void>
  markResourceUploaded(Id: string, Size: number, ContentType?: string): Promise<boolean>
  restoreResource(Id: string): Promise<Resource | null>
  findActiveBySource(Url: string): Promise<Resource | null>
  dataUriExists(Uri: string): Promise<boolean>
  softDeleteResource(Id: string): Promise<boolean>
  listResourcesByUriSuffix(Suffix: string): Promise<Resource[]>
  searchResources(Query: string, Limit: number): Promise<Resource[]>
  getChunkByIndex(ResourceId: string, ChunkIndex: number): Promise<Chunk | null>

  writeChunksWithEmbeddings(
    ResourceId: string,
    Chunks: Pick<Chunk, 'chunk_index' | 'content' | 'start_offset' | 'end_offset'>[],
    Vectors: Pick<Embedding, 'dimension' | 'model' | 'embedding'>[],
  ): Promise<number>
  getChunksPage(ResourceId: string, Offset: number, Limit: number, Search: string): Promise<{ Items: Chunk[]; TotalCount: number }>
  listChunksByResource(ResourceId: string): Promise<Chunk[]>
  deleteChunksByResource(ResourceId: string): Promise<void>

  getSession(Id: string): Promise<Session | null>
  createMessage(Data: Pick<Message, 'session_id' | 'role' | 'content' | 'parts'> & Partial<Pick<Message, 'trace_id'>>): Promise<Message>
  getMessagesBySession(SessionId: string): Promise<Message[]>

  insertTrace(Entry: TraceStart): Promise<void>
  finishTrace(TraceId: string, Finish: TraceFinish): Promise<void>
  setTraceSession(TraceId: string, SessionId: string): Promise<void>
  setTraceResource(TraceId: string, ResourceId: string): Promise<void>
  getTrace(TraceId: string): Promise<Trace | null>
  insertTraceStage(TraceId: string, Stage: TraceStageInput): Promise<void>
  listTraceStages(TraceId: string): Promise<TraceStage[]>

  listChatSessions(Offset: number, Limit: number): Promise<{ Items: ChatSessionSummary[]; TotalCount: number }>
  getChatTrace(TraceId: string): Promise<ChatTraceSummary | null>
  getSessionTranscript(SessionId: string): Promise<ChatTurn[]>

  listDatasets(): Promise<EvalDataset[]>
  getDataset(Id: string): Promise<EvalDataset | null>
  createDataset(Data: { name: string; note: string }): Promise<EvalDataset>
  updateDataset(Id: string, Data: { name: string; note: string }): Promise<EvalDataset | null>
  setDatasetBaseline(Id: string, RunId: string): Promise<EvalDataset | null>
  countRunsOfDataset(DatasetId: string): Promise<number>
  deleteDataset(Id: string): Promise<boolean>
  duplicateDataset(Id: string): Promise<EvalDataset | null>
  listCases(DatasetId: string): Promise<EvalCase[]>
  getCase(Id: string): Promise<EvalCase | null>
  createCase(DatasetId: string, Data: EvalCaseInput): Promise<EvalCase>
  updateCase(Id: string, Data: Omit<EvalCaseInput, 'case_key'>): Promise<EvalCase | null>
  deleteCase(Id: string): Promise<boolean>
  nextCaseKey(DatasetId: string, Level: string): Promise<string>
  upsertCase(DatasetId: string, Data: EvalCaseInput & { case_key: string }): Promise<EvalCase>
  listConfigs(Kind: EvalConfigKind): Promise<EvalConfig[]>
  getConfig(Id: string): Promise<EvalConfig | null>
  createConfig(Data: { kind: EvalConfigKind; name: string; config: Record<string, unknown> }): Promise<EvalConfig>
  updateConfig(Id: string, Data: { name: string; config: Record<string, unknown> }): Promise<EvalConfig | null>
  deleteConfig(Id: string): Promise<boolean>
  duplicateConfig(Id: string): Promise<EvalConfig | null>

  createRun(Data: { dataset_id: string; run_config_id: string; metric_config_id: string; snapshot: EvalRunSnapshot }): Promise<EvalRun>
  getRun(Id: string): Promise<EvalRun | null>
  listRuns(DatasetId: string | null, RunConfigId?: string | null): Promise<EvalRun[]>
  appendRunResult(Id: string, Result: EvalRunResult): Promise<boolean>
  setHumanResult(RunId: string, Entry: EvalHumanResult): Promise<EvalHumanResult[] | null>
  startRun(Id: string): Promise<boolean>
  finishRun(Id: string, Status: 'done' | 'failed' | 'cancelled', Data: { duration_ms: number; error_reason?: string | null }): Promise<boolean>
  cancelQueuedRun(Id: string): Promise<boolean>
  markInterruptedRuns(): Promise<number>
  deleteRun(Id: string): Promise<boolean>
  getChunkByDataUri(Uri: string, ChunkIndex: number): Promise<Chunk | null>
}

interface CodebaseRepo {
  createCodebase(
    Data: Pick<Codebase, 'title' | 'original_filename' | 'data_uri' | 'content_type' | 'status'>,
  ): Promise<Codebase>
  getCodebase(Id: string): Promise<Codebase | null>
  getCodebaseSummary(Id: string): Promise<CodebaseSummary | null>
  listCodebases(Offset: number, Limit: number, Search: string): Promise<{ Items: CodebaseSummary[]; TotalCount: number }>
  updateCodebaseStatus(Id: string, Status: CodebaseStatus, Reason?: string): Promise<boolean>
  markCodebaseReady(
    Id: string,
    Data: Pick<Codebase, 'storage_size_bytes' | 'manifest' | 'file_count' | 'declared_uncompressed_bytes'>,
  ): Promise<CodebaseSummary | null>
  deleteCodebase(Id: string): Promise<CodebaseSummary | null>
  codebaseDataUriExists(Uri: string): Promise<boolean>
  markStaleCodebases(): Promise<{ processing: number; uploads: number }>
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
    this.modelId = modelIdOf(Name)
    this.dimensions = Config.embeddingDimensions
  }
}

@singleton()
class ChatHandle {
  readonly model: LanguageModelV4
  readonly models: LanguageModels
  readonly providers: LanguageModelProviders
  readonly names: LanguageModelNames

  constructor(@inject(AppConfig) Config: AppConfig, @inject(ModelRegistry) Models: RegistedModels) {
    const Name = Config.chatModel
    this.models = Models.languageModels
    this.providers = Models.languageProviders
    this.names = Models.languageNames
    if (!Object.hasOwn(this.models, Name)) {
      logError('E_CHAT_MODEL', `CHAT_MODEL=${Name} 不在册；在册对话句柄=${Object.keys(this.models).join(',') || '无'}`)
      process.exit(1)
    }
    this.model = this.models[Name as LanguageModelId]!
  }

  resolve(Name: string): LanguageModelV4 | undefined {
    return Object.hasOwn(this.models, Name) ? this.models[Name as LanguageModelId] : undefined
  }

  catalog(): { id: string; provider: string; name: string }[] {
    return Object.keys(this.models).map((Id) => ({
      id: Id,
      provider: this.providers[Id as LanguageModelId]!,
      name: this.names[Id as LanguageModelId] ?? Id,
    }))
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

  markStaleOnBoot() {
    return markStaleOnBoot(this.orm)
  }

  vectorCandidates(QueryVector: number[], Limit: number, Dim: number) {
    return vectorCandidates(this.db, QueryVector, Limit, Dim)
  }

  lexicalCandidates(QueryText: string, Limit: number) {
    return lexicalCandidates(this.db, QueryText, Limit)
  }

  createResource(
    Data: Pick<Resource, 'title' | 'source' | 'data_uri' | 'content_type' | 'status'>
      & Partial<Pick<Resource, 'storage_size_bytes' | 'content_hash'>>,
  ) {
    return createResource(this.orm, Data)
  }

  getResource(Id: string) {
    return getResource(this.orm, Id)
  }

  getResourceIncludingDeleted(Id: string) {
    return getResourceIncludingDeleted(this.orm, Id)
  }

  getResourceByContentHash(Hash: string) {
    return getResourceByContentHash(this.orm, Hash)
  }

  listDeletedResources(Offset: number, Limit: number, Search: string, Sort?: string, Order?: 'asc' | 'desc') {
    return listDeletedResources(this.orm, Offset, Limit, Search, Sort, Order)
  }

  purgeResource(Id: string) {
    return purgeResource(this.orm, Id)
  }

  resourceCounts() {
    return resourceCounts(this.orm)
  }

  updateResourceStatus(Id: string, Status: ResourceStatus, Reason?: string) {
    return updateResourceStatus(this.orm, Id, Status, Reason)
  }

  updateResourceTitle(Id: string, Title: string) {
    return updateResourceTitle(this.orm, Id, Title)
  }

  markResourceUploaded(Id: string, Size: number, ContentType?: string) {
    return markResourceUploaded(this.orm, Id, Size, ContentType)
  }

  restoreResource(Id: string) {
    return restoreResource(this.orm, Id)
  }

  findActiveBySource(Url: string) {
    return findActiveBySource(this.orm, Url)
  }

  dataUriExists(Uri: string) {
    return dataUriExists(this.orm, Uri)
  }

  softDeleteResource(Id: string) {
    return softDeleteResource(this.orm, Id)
  }

  listResourcesByUriSuffix(Suffix: string) {
    return listResourcesByUriSuffix(this.db, Suffix)
  }

  searchResources(Query: string, Limit: number) {
    return searchResources(this.orm, Query, Limit)
  }

  getChunkByIndex(ResourceId: string, ChunkIndex: number) {
    return getChunkByIndex(this.db, ResourceId, ChunkIndex)
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

  listChunksByResource(ResourceId: string) {
    return listChunksByResource(this.db, ResourceId)
  }

  deleteChunksByResource(ResourceId: string) {
    return deleteChunksByResource(this.db, ResourceId)
  }

  getSession(Id: string) {
    return getSession(this.orm, Id)
  }

  createMessage(Data: Pick<Message, 'session_id' | 'role' | 'content' | 'parts'> & Partial<Pick<Message, 'trace_id'>>) {
    return createMessage(this.orm, Data)
  }

  getMessagesBySession(SessionId: string) {
    return getMessagesBySession(this.orm, SessionId)
  }

  insertTrace(Entry: TraceStart) {
    return insertTrace(this.orm, Entry)
  }

  finishTrace(TraceId: string, Finish: TraceFinish) {
    return finishTrace(this.orm, TraceId, Finish)
  }

  setTraceSession(TraceId: string, SessionId: string) {
    return setTraceSession(this.orm, TraceId, SessionId)
  }

  setTraceResource(TraceId: string, ResourceId: string) {
    return setTraceResource(this.orm, TraceId, ResourceId)
  }

  getTrace(TraceId: string) {
    return getTrace(this.orm, TraceId)
  }

  insertTraceStage(TraceId: string, Stage: TraceStageInput) {
    return insertTraceStage(this.orm, TraceId, Stage)
  }

  listTraceStages(TraceId: string) {
    return listTraceStages(this.orm, TraceId)
  }

  listChatSessions(Offset: number, Limit: number) {
    return listChatSessions(this.orm, Offset, Limit)
  }

  getChatTrace(TraceId: string) {
    return getChatTrace(this.orm, TraceId)
  }

  getSessionTranscript(SessionId: string) {
    return getSessionTranscript(this.orm, SessionId)
  }

  listDatasets() {
    return listDatasets(this.orm)
  }

  getDataset(Id: string) {
    return getDataset(this.orm, Id)
  }

  createDataset(Data: { name: string; note: string }) {
    return createDataset(this.orm, Data)
  }

  updateDataset(Id: string, Data: { name: string; note: string }) {
    return updateDataset(this.orm, Id, Data)
  }

  setDatasetBaseline(Id: string, RunId: string) {
    return setDatasetBaseline(this.orm, Id, RunId)
  }

  countRunsOfDataset(DatasetId: string) {
    return countRunsOfDataset(this.orm, DatasetId)
  }

  deleteDataset(Id: string) {
    return deleteDataset(this.orm, Id)
  }

  duplicateDataset(Id: string) {
    return duplicateDataset(this.orm, Id)
  }

  listCases(DatasetId: string) {
    return listCases(this.orm, DatasetId)
  }

  getCase(Id: string) {
    return getCase(this.orm, Id)
  }

  createCase(DatasetId: string, Data: EvalCaseInput) {
    return createCase(this.orm, DatasetId, Data)
  }

  updateCase(Id: string, Data: Omit<EvalCaseInput, 'case_key'>) {
    return updateCase(this.orm, Id, Data)
  }

  deleteCase(Id: string) {
    return deleteCase(this.orm, Id)
  }

  nextCaseKey(DatasetId: string, Level: string) {
    return nextCaseKey(this.orm, DatasetId, Level)
  }

  upsertCase(DatasetId: string, Data: EvalCaseInput & { case_key: string }) {
    return upsertCase(this.orm, DatasetId, Data)
  }

  listConfigs(Kind: EvalConfigKind) {
    return listConfigs(this.orm, Kind)
  }

  getConfig(Id: string) {
    return getConfig(this.orm, Id)
  }

  createConfig(Data: { kind: EvalConfigKind; name: string; config: Record<string, unknown> }) {
    return createConfig(this.orm, Data)
  }

  updateConfig(Id: string, Data: { name: string; config: Record<string, unknown> }) {
    return updateConfig(this.orm, Id, Data)
  }

  deleteConfig(Id: string) {
    return deleteConfig(this.orm, Id)
  }

  duplicateConfig(Id: string) {
    return duplicateConfig(this.orm, Id)
  }

  createRun(Data: { dataset_id: string; run_config_id: string; metric_config_id: string; snapshot: EvalRunSnapshot }) {
    return createRun(this.orm, Data)
  }

  getRun(Id: string) {
    return getRun(this.orm, Id)
  }

  listRuns(DatasetId: string | null, RunConfigId: string | null = null) {
    return listRuns(this.orm, DatasetId, RunConfigId)
  }

  appendRunResult(Id: string, Result: EvalRunResult) {
    return appendRunResult(this.orm, Id, Result)
  }

  startRun(Id: string) {
    return startRun(this.orm, Id)
  }

  finishRun(Id: string, Status: 'done' | 'failed' | 'cancelled', Data: { duration_ms: number; error_reason?: string | null }) {
    return finishRun(this.orm, Id, Status, Data)
  }

  cancelQueuedRun(Id: string) {
    return cancelQueuedRun(this.orm, Id)
  }

  markInterruptedRuns() {
    return markInterruptedRuns(this.orm)
  }

  deleteRun(Id: string) {
    return deleteRun(this.orm, Id)
  }

  setHumanResult(RunId: string, Entry: EvalHumanResult) {
    return setHumanResult(this.orm, RunId, Entry)
  }

  getChunkByDataUri(Uri: string, ChunkIndex: number) {
    return getChunkByDataUri(this.db, Uri, ChunkIndex)
  }
}

@singleton()
class EvalPostgresRepo extends PostgresRepo {
  constructor(@inject(AppConfig) Config: AppConfig) {
    super(new EvalDbHandle(Config))
  }
}

@singleton()
class PostgresCodebaseRepo implements CodebaseRepo {
  private readonly orm: Orm

  constructor(@inject(DbHandle) Db: DbHandle) {
    this.orm = createOrm(Db.pool)
  }

  createCodebase(
    Data: Pick<Codebase, 'title' | 'original_filename' | 'data_uri' | 'content_type' | 'status'>,
  ) {
    return createCodebase(this.orm, Data)
  }

  getCodebase(Id: string) {
    return getCodebase(this.orm, Id)
  }

  getCodebaseSummary(Id: string) {
    return getCodebaseSummary(this.orm, Id)
  }

  listCodebases(Offset: number, Limit: number, Search: string) {
    return listCodebases(this.orm, Offset, Limit, Search)
  }

  updateCodebaseStatus(Id: string, Status: CodebaseStatus, Reason?: string) {
    return updateCodebaseStatus(this.orm, Id, Status, Reason)
  }

  markCodebaseReady(
    Id: string,
    Data: Pick<Codebase, 'storage_size_bytes' | 'manifest' | 'file_count' | 'declared_uncompressed_bytes'>,
  ) {
    return markCodebaseReady(this.orm, Id, Data)
  }

  deleteCodebase(Id: string) {
    return deleteCodebase(this.orm, Id)
  }

  codebaseDataUriExists(Uri: string) {
    return codebaseDataUriExists(this.orm, Uri)
  }

  markStaleCodebases() {
    return markStaleCodebases(this.orm)
  }
}

@singleton()
class PostgresConfigRepo {
  private readonly orm: Orm

  constructor(@inject(DbHandle) Db: DbHandle) {
    this.orm = createOrm(Db.pool)
  }

  readConfig() {
    return readConfig(this.orm)
  }

  listProviders() {
    return listProviders(this.orm)
  }

  getProvider(Id: string) {
    return getProvider(this.orm, Id)
  }

  getProviderByName(Name: string) {
    return getProviderByName(this.orm, Name)
  }

  createProvider(Input: CreateProviderInput) {
    return createProvider(this.orm, Input)
  }

  setProviderBaseUrl(Id: string, BaseUrl: string | null) {
    return setProviderBaseUrl(this.orm, Id, BaseUrl)
  }

  setProviderEnabled(Id: string, Enabled: boolean) {
    return setProviderEnabled(this.orm, Id, Enabled)
  }

  setProviderApiKey(Id: string, Ciphertext: string | null) {
    return setProviderApiKey(this.orm, Id, Ciphertext)
  }

  setProviderHeaders(Id: string, Ciphertext: string | null) {
    return setProviderHeaders(this.orm, Id, Ciphertext)
  }

  setProviderQuery(Id: string, Query: Record<string, string>) {
    return setProviderQuery(this.orm, Id, Query)
  }

  setProviderOptions(Id: string, Options: Record<string, unknown>) {
    return setProviderOptions(this.orm, Id, Options)
  }

  deleteProvider(Id: string) {
    return deleteProvider(this.orm, Id)
  }

  listModels() {
    return listModels(this.orm)
  }

  getModel(Id: string) {
    return getModel(this.orm, Id)
  }

  createModel(Input: CreateModelInput) {
    return createModel(this.orm, Input)
  }

  updateModel(Id: string, Input: UpdateModelInput) {
    return updateModel(this.orm, Id, Input)
  }

  deleteModel(Id: string) {
    return deleteModel(this.orm, Id)
  }

  listDefaults() {
    return listDefaults(this.orm)
  }

  getDefault(Id: 'default' | 'embedding') {
    return getDefault(this.orm, Id)
  }

  upsertDefault(Id: 'default' | 'embedding', ProviderId: string, ModelId: string, DisplayName: string) {
    return upsertDefault(this.orm, Id, ProviderId, ModelId, DisplayName)
  }

  deleteDefault(Id: 'default' | 'embedding') {
    return deleteDefault(this.orm, Id)
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
    @inject(RetrieverFactory) private readonly factory: RetrieverFactory,
    @inject(PostgresRepo) Repo: Repo,
    @inject(EmbeddingHandle) private readonly embedding: EmbeddingHandle,
    @inject(AppConfig) private readonly config: AppConfig,
  ) {
    this.retriever = this.forRepo(Repo)
  }

  forRepo(Repo: Repo): Retriever {
    const recipe: RetrieverRecipe = {
      ...RETRIEVER_RECIPE_NAMES,
      deps: { repo: Repo, embedding: this.embedding, config: this.config },
    }
    return this.factory.assemble(recipe)
  }
}

type RegistedProviders = Partial<Record<ProviderEntryName, ProviderV4>>

type LanguageModels = Partial<Record<LanguageModelId, LanguageModelV4>>

type LanguageModelProviders = Partial<Record<LanguageModelId, string>>

type LanguageModelNames = Partial<Record<LanguageModelId, string>>

type EmbeddingModels = Partial<Record<EmbeddingModelId, EmbeddingModelV4>>

type RegistedModels = {
  languageModels: LanguageModels
  languageProviders: LanguageModelProviders
  languageNames: LanguageModelNames
  embeddingModels: EmbeddingModels
}
