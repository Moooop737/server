/**
 * 基础层唯一的对外门 —— 别盒只准从这里 import（AD-6：adapter/ 用单一 contract.ts 门，不逐盒建）。
 * 门只交服务、不交连接：DbHandle 造池，PostgresRepo 持有池与 Drizzle 实例；Pool 与 SQL 文本仍不出 repo/（AD-3），
 * 所以这里不出现 `pg`，也没有「借一条连接」的原语可导出。
 * Repo 按用例分组：资源/分块、会话/消息、检索候选、trace 写入、评测题集/配置、管线定义；CRUD 的 HTTP 投影由 routes/crud.ts 统一注册 hono-crud。
 * EvalPostgresRepo 是同一套 Repo 方法换评测库的池（继承 PostgresRepo）；只在隔离模式构造，共享模式评测世界直接用 PostgresRepo。
 * Codebases 是独立领域：PostgresCodebaseRepo 只交 CodebaseRepo 接口，不复用 Repo 的资源方法，也不进 hono-crud。
 * ChunkCandidate 就是检索命中去掉名次分那一位 —— score 由融合侧产出，不该由基础层造，
 * 所以两条候选查询交出 ChunkCandidate，retrieve/pipeline/ 的组件补上 score 再交给结果组件。
 * RuntimeRetrievalRegistry 是检索运行时的唯一来源：快照存当前管线（装配探针校验，坏管线 reload 留旧快照）；
 * retriever() 无参，repo / 模型注册表在构造时注入，调用方不传依赖。默认嵌入的解析仍统一走 RuntimeModelRegistry。
 * 嵌入默认的解析与 E_NO_EMBEDDING_MODEL 只在 RuntimeModelRegistry（D17），本门不再有 EmbeddingHandle。
 * 维度来自 models.dimensions（默认行指向的嵌入模型行），不再有 env 的 EMBEDDING_DIMENSIONS。
 * 三个 Ollama 探针是原生只读 HTTP（/api/version、/api/tags、/api/ps），不是 SDK，只是服务商接入的一部分。
 * 方法级前置条件（调用方只读这一份，不必开 repo/ 各文件）：
 * · writeChunksWithEmbeddings：Vectors 与 Chunks 同序等长（由调用方 ingest 判长度）；chunk、向量、转 ready 同一事务，
 *   不存在「向量已落、行还 processing」；返回写入 chunk 数；期间资源被软删则整笔回滚并抛 code='E_RESOURCE_GONE'。
 * · findActiveBySource：只认 status ∈ uploading/uploaded/processing/ready 且未软删。
 * · softDeleteResource：resources 留痕、chunks 物理删（embeddings 经 FK source_id→chunks.id ON DELETE CASCADE 随之消失）；
 *   返回 false = 该行不存在或早已软删。
 * · markResourceUploaded：对象已 stat 后确认大小，从 uploading/uploaded/upload_failed/process_failed/ready 转 uploaded（后两者是重试入口）。
 * · restoreResource：只接软删行，清 deleted_at 后回到 uploaded；不是软删行返回 null。
 * · markStaleOnBoot：processing → process_failed，超过 24h 的 uploading → upload_failed。
 * · dimensionsInStore：数的是 embeddings 的维度事实，与行是否软删无关；库不可达时抛，由调用方处置（检索层每请求现查一次，见 retrieve/pipeline/components.ts）。
 * · updateResourceStatus / 写入路径都自带 `deleted_at IS NULL` 谓词，不由调用方拼。
 * · trace 两条只写 traces 公共行；insert/finish 失败不影响业务，吞错与日志归调用方（见 trace/systemtrace/endpoint.ts）。
 * 唯一例外：`connection/pool.ts` 的 createDbPool 被三个 gitignore 的对账脚本直接 import（它们要一条独立连接做 raw 校数），不经本门。
 * 本层的四格分工：`connection/`＝怎么连上外部服务（pg 池、Ollama 的原生地址与探活），`repo/`＝按功能分的行、SQL 与实体形状（resource.ts / chunk.ts / session.ts / message.ts / trace.ts / search-*.ts / pipeline.ts），`provider/`＋`model/`＝AI SDK 的网关、句柄与 embed 调用封装。
 * `repo/orm/`＝Drizzle schema 与实例（只覆盖四张 CRUD 表）；BM25/向量仍走 `repo/search-*.ts` 的裸 SQL。
 * 唯一例外：四张 Drizzle 表经本门交给 routes/crud.ts 的 hono-crud 注册（需要表与 model metadata）。
 * 实体形状不再有跨层共享盒（原 `types/` 已删）：别盒要用哪一位，由本门逐个点名交出（现交 Resource 与四张 Drizzle 表）。
 */

export { RuntimeRetrievalRegistry, RetrievalRegistryError, PostgresRepo, EvalPostgresRepo, PostgresCodebaseRepo, PostgresConfigRepo, PostgresPipelineRepo, ObjectStoreHandle, ollamaHealthCheck, ollamaModelList, ollamaStatusList, embedChunks, assembleRetriever, RETRIEVAL_COMPONENTS }
export { resources, sessions, messages, traces } from './repo/orm/schema'
export { listChatSessions, getChatTrace, getSessionTranscript } from './repo/observability'
export { ObjectStoreError } from './storage/object-store'
export type { Repo, CodebaseRepo, ChunkCandidate, Resource, ResourceStatus, ResourceCounts, Message, Trace, TraceStage, TraceStageInput, TracePayloads, TracePayloadOmitReason }
export type { ProviderKind, ModelKind, ProviderRow, ModelWithProvider, DefaultRow, ConfigSnapshot, CreateProviderInput, CreateModelInput, UpdateModelInput } from './repo/config'
export type { PipelineRow, PipelineSummaryRow } from './repo/pipeline'
export type { RetrievalSnapshot, RetrievalStatus, RetrievalReloadResult }
export type { EvalDataset, EvalCase, EvalGold, EvalAssertion, EvalAssertions, EvalConfig, EvalConfigKind, EvalCaseInput } from './repo/eval'
export type { EvalRun, EvalRunStatus, EvalRunSnapshot, EvalRunCaseSnapshot, EvalRunResult, EvalHumanResult, EvalVerdict, EvalAssertionCheck, EvalAssertionResult, EvalJudgeResult, EvalCitation } from './repo/eval-run'
export type { Codebase, CodebaseSummary, CodebaseEntry, CodebaseStatus } from './repo/codebase'
export type { ChatSessionSummary, ChatTraceSummary, ChatTurn, TranscriptMessage } from './repo/observability'
export type { ObjectStore, ObjectStat, ObjectBody, ObjectGetOptions, ObjectPresignOptions, ObjectPresignPutOptions } from './storage/object-store'

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { pingDb } from './connection/pool'
import { DbHandle } from './connection/db'
import { EvalDbHandle } from './connection/db'
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
import { PostgresConfigRepo } from './repo/config'
import { PostgresPipelineRepo } from './repo/pipeline'
import { ollamaHealthCheck, ollamaModelList, ollamaStatusList } from './connection/ollama'
import { RuntimeModelRegistry } from './model/runtime-registry'
import { embedChunks } from './model/embed-chunks'
import { createS3Client, putObject, statObject, getObject, deleteObject, presignGet, presignPut, pingBucket, ensureBucket } from './storage/s3'
import type { ObjectStore, ObjectGetOptions, ObjectPresignOptions, ObjectPresignPutOptions } from './storage/object-store'

import { AppConfig } from '../config'
import { logError, logInfo } from '../trace/systemtrace/log'
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
import type { ProviderV4 } from '@ai-sdk/provider';
import type { Retriever } from '../retrieve/contracts';
import type { PipelineDef } from '../retrieve/pipeline/pipeline';
import { assemblePipeline } from '../retrieve/pipeline/pipeline';
import { NoopStageSink } from '../trace/systemtrace/stage';
import { assembleRetriever, RETRIEVAL_COMPONENTS } from './retrieve/default';

interface Repo {
  ping(): Promise<boolean>
  dimensionsInStore(ModelKey?: string): Promise<number[]>
  markStaleOnBoot(): Promise<{ resources: number; uploads: number }>
  vectorCandidates(QueryVector: number[], Limit: number, Dim: number, ModelKey: string): Promise<ChunkCandidate[]>
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

  dimensionsInStore(ModelKey?: string) {
    return dimensionsInStore(this.db, ModelKey)
  }

  markStaleOnBoot() {
    return markStaleOnBoot(this.orm)
  }

  vectorCandidates(QueryVector: number[], Limit: number, Dim: number, ModelKey: string) {
    return vectorCandidates(this.db, QueryVector, Limit, Dim, ModelKey)
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

interface RetrievalSnapshot {
  generation: number
  version: number
  loaded_at: string
  pipeline: PipelineDef
}

interface RetrievalReloadResult {
  ok: boolean
  error_code: string | null
}

interface RetrievalStatus {
  generation: number
  version: number
  loaded_at: string
  node_count: number
  output_node: string | null
  last_reload: { ok: boolean; at: string; error_code: string | null } | null
}

class RetrievalRegistryError extends Error {
  readonly code: string

  constructor(Code: string, Message: string) {
    super(Message)
    this.name = 'RetrievalRegistryError'
    this.code = Code
  }
}

@singleton()
class RuntimeRetrievalRegistry {
  private snapshot: RetrievalSnapshot | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private lastReload: RetrievalStatus['last_reload'] = null
  private generation = 0
  private readonly pipelineRepo: PostgresPipelineRepo
  private readonly models: RuntimeModelRegistry
  private readonly repo: Repo

  constructor(
    @inject(PostgresPipelineRepo) PipelineRepo: PostgresPipelineRepo,
    @inject(RuntimeModelRegistry) Models: RuntimeModelRegistry,
    @inject(PostgresRepo) Repo: Repo,
  ) {
    this.pipelineRepo = PipelineRepo
    this.models = Models
    this.repo = Repo
  }

  async load(): Promise<RetrievalSnapshot> {
    return this.enqueue(async () => {
      const Next = await this.build()
      this.snapshot = Next
      return Next
    })
  }

  async reload(): Promise<RetrievalReloadResult> {
    return this.enqueue(async () => {
      try {
        const Next = await this.build()
        this.snapshot = Next
        this.lastReload = { ok: true, at: new Date().toISOString(), error_code: null }
        logInfo('I_RETRIEVAL_RELOAD', `热更新成功 generation=${Next.generation} version=${Next.version}`)
        return { ok: true, error_code: null }
      } catch (Err) {
        const Code = retrievalErrorCode(Err)
        this.lastReload = { ok: false, at: new Date().toISOString(), error_code: Code }
        logError('E_RETRIEVAL_RELOAD', `热更新失败，继续用旧快照：${Code}`)
        return { ok: false, error_code: Code }
      }
    })
  }

  current(): RetrievalSnapshot {
    if (this.snapshot === null) {
      throw new RetrievalRegistryError('E_RETRIEVAL_NOT_LOADED', '检索管线尚未装载')
    }
    return this.snapshot
  }

  status(): RetrievalStatus {
    const Snap = this.current()
    return {
      generation: Snap.generation,
      version: Snap.version,
      loaded_at: Snap.loaded_at,
      node_count: Snap.pipeline.nodes.length,
      output_node: Snap.pipeline.output ?? null,
      last_reload: this.lastReload,
    }
  }

  retriever(): Retriever {
    return assembleRetriever(this.current().pipeline, RETRIEVAL_COMPONENTS, { repo: this.repo, registry: this.models })
  }

  private async build(): Promise<RetrievalSnapshot> {
    const Row = await this.pipelineRepo.readDefault()
    if (Row === null) {
      throw new RetrievalRegistryError('E_RETRIEVAL_CONFIG_LOAD', 'pipeline_defs 缺默认管线行')
    }
    if (Row.output_node === null) {
      throw new RetrievalRegistryError('E_PIPELINE_INVALID', '默认管线缺少输出节点')
    }
    const Def: PipelineDef = { nodes: Row.nodes, output: Row.output_node }
    assemblePipeline(Def, RETRIEVAL_COMPONENTS, {
      repo: this.repo,
      registry: this.models,
      embedding: null,
      sink: NoopStageSink,
    })
    this.generation += 1
    logInfo('I_RETRIEVAL_REGISTRY', `generation=${this.generation} version=${Row.version} nodes=${Def.nodes.length}`)
    return {
      generation: this.generation,
      version: Row.version,
      loaded_at: new Date().toISOString(),
      pipeline: Def,
    }
  }

  private enqueue<T>(Fn: () => Promise<T>): Promise<T> {
    const Run = this.queue.then(Fn, Fn)
    this.queue = Run.then(() => undefined, () => undefined)
    return Run
  }
}

function retrievalErrorCode(Err: unknown): string {
  let Current: unknown = Err
  while (Current !== null && typeof Current === 'object') {
    const Code = (Current as { code?: unknown }).code
    if (typeof Code === 'string') return Code
    Current = (Current as { cause?: unknown }).cause
  }
  return 'E_RETRIEVAL_CONFIG_LOAD'
}

