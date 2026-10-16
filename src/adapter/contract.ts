/**
 * 基础层唯一的对外门 —— 别盒只准从这里 import（AD-6：adapter/ 用单一 contract.ts 门，不逐盒建）。
 * 门只交服务、不交连接：createRepo(Config) 在内部造池并持有，Pool 与任何 SQL 文本都出不了 repo/（AD-3），
 * 所以这里不出现 `pg`，也没有「借一条连接」的原语可导出。
 * Repo 的方法名逐个沿用现网 Repository 的 16 个（含五个 NotImplemented 占位，语义未改），另加五个：
 * ping / dimensionsInStore / markInterruptedAsFailed / vectorCandidates / lexicalCandidates。
 * ChunkCandidate 就是检索命中去掉名次分那一位 —— score 由融合侧产出，不该由基础层造，
 * 所以两条候选查询交出 ChunkCandidate，retrieve/search/ 的两个适配器补上 score: 0 再交给 Retriever。
 * EmbeddingTarget 是装配层从 model 清单里选定那一行后交出的一对（句柄 + 写进 embeddings.model 的标识 + 本次要截到几维）；
 * 维度不进 model 表 —— SDK 句柄没有 dimensions 位，它是调用选项，env 的 EMBEDDING_DIMENSIONS 才是它的来源。
 * 三个 Ollama 探针是原生只读 HTTP（/api/version、/api/tags、/api/ps），不是 SDK，只是服务商接入的一部分。
 * SDK 那两格交的是两个工厂：providerRegistry() 按 env 里在位的 Key 造服务商（缺 Key 不进表、不报错），modelRegistry(Providers) 把在册服务商兑换成句柄。
 * 两者都只在装配期各调一次，句柄身份因此进程级唯一；providers 这层中间产物不出门，外面只见 models。
 * 方法级前置条件（调用方只读这一份，不必开 repo/ 各文件）：
 * · writeChunksWithEmbeddings：Vectors 与 Chunks 同序等长（由调用方 pipeline 判长度）；chunk、向量、转 ready 同一事务，
 *   不存在「向量已落、行还 processing」；返回写入 chunk 数；期间资源被软删则整笔回滚并抛 code='E_RESOURCE_GONE'。
 * · findActiveBySource：只认 status ∈ ready/processing 且未软删。
 * · countResourcesByStatus：只数未软删，三个状态都给键（没命中补 0）；「空库 / 全无 ready」的判定归调用方。
 * · softDeleteResource：resources 留痕、chunks 物理删（embeddings 经 FK source_id→chunks.id ON DELETE CASCADE 随之消失）；
 *   返回 false = 该行不存在或早已软删。
 * · dimensionsInStore：数的是 embeddings 的维度事实，与行是否软删无关；库不可达时抛，由 bootstrap 把 vectorDimensions 留在 null。
 * · updateResourceStatus / 写入路径都自带 `deleted_at IS NULL` 谓词，不由调用方拼。
 * 唯一例外：`connection/pool.ts` 的 createDbPool 被三个 gitignore 的对账脚本直接 import（它们要一条独立连接做 raw 校数），不经本门。
 * 本层的三格分工：`connection/`＝怎么连上外部服务（pg 池、Ollama 的原生地址与探活），`repo/`＝行与 SQL 文本，`provider/`＋`model/`＝AI SDK 的网关与句柄。
 */

export { createRepo, ollamaHealthCheck, ollamaModelList, ollamaStatusList, providerRegistry, modelRegistry }
export type { Repo, ChunkCandidate, EmbeddingTarget, OllamaModelDetails, OllamaModelEntry, OllamaModelStatus, ProviderEntryName, LanguageModelId, EmbeddingModelId, RegistedProviders, RegistedModels }

import { createDbPool, pingDb } from './connection/pool'
import {
  createResource, updateResourceStatus, updateResourceTitle, softDeleteResource, markInterruptedAsFailed,
} from './repo/write-resource'
import { writeChunksWithEmbeddings, deleteChunksByResource } from './repo/write-content'
import {
  getResource, listResources, countResourcesByStatus, findActiveBySource, getChunksByResource, dimensionsInStore,
  findResourcesByStatus, createSession, getSession, createMessage, getMessagesBySession,
} from './repo/read-content'
import { vectorCandidates } from './repo/search-vector'
import { lexicalCandidates } from './repo/search-lexical'
import { ollamaHealthCheck, ollamaModelList, ollamaStatusList } from './connection/ollama'
import { providerRegistry, type ProviderEntryName } from './provider/registry'
import { modelRegistry, type EmbeddingModelId, type LanguageModelId} from './model/registry'

import type { AppConfig } from '../config'
import type { Chunk, Embedding, Message, Resource, Session } from '../types/types'
import type { OllamaModelDetails, OllamaModelEntry, OllamaModelStatus } from './connection/ollama'
import type { EmbeddingModelV4, LanguageModelV4, ProviderV4 } from '@ai-sdk/provider';

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
  listResources(): Promise<Resource[]>
  updateResourceStatus(Id: string, Status: Resource['status'], Reason?: string): Promise<void>
  updateResourceTitle(Id: string, Title: string): Promise<void>
  findActiveBySource(Url: string): Promise<Resource | null>
  softDeleteResource(Id: string): Promise<boolean>
  findResourcesByStatus(Status: Resource['status']): Promise<Resource[]>
  countResourcesByStatus(): Promise<Record<Resource['status'], number>>

  writeChunksWithEmbeddings(
    ResourceId: string,
    Chunks: Pick<Chunk, 'chunk_index' | 'content' | 'start_offset' | 'end_offset'>[],
    Vectors: Pick<Embedding, 'dimension' | 'model' | 'embedding'>[],
  ): Promise<number>
  getChunksByResource(ResourceId: string): Promise<Chunk[]>
  deleteChunksByResource(ResourceId: string): Promise<void>

  createSession(Title?: string): Promise<Session>
  getSession(Id: string): Promise<Session | null>
  createMessage(Data: Pick<Message, 'session_id' | 'role' | 'content' | 'sources'>): Promise<Message>
  getMessagesBySession(SessionId: string): Promise<Message[]>
}

interface ChunkCandidate {
  chunk: Chunk
  docTitle: string
  source: string | null
  dataUri: string
  similarity: number | null
  lexicalScore: number | null
}

interface EmbeddingTarget {
  model: EmbeddingModelV4
  modelId: string
  dimensions: number
}

function createRepo(Config: AppConfig): Repo {
  const db = createDbPool(Config.databaseUrl)

  return {
    ping: () => pingDb(db),
    dimensionsInStore: () => dimensionsInStore(db),
    markInterruptedAsFailed: () => markInterruptedAsFailed(db),
    vectorCandidates: (QueryVector, Limit, Dim) => vectorCandidates(db, QueryVector, Limit, Dim),
    lexicalCandidates: (QueryText, Limit) => lexicalCandidates(db, QueryText, Limit),

    createResource: (Data) => createResource(db, Data),
    getResource: (Id) => getResource(db, Id),
    listResources: () => listResources(db),
    updateResourceStatus: (Id, Status, Reason) => updateResourceStatus(db, Id, Status, Reason),
    updateResourceTitle: (Id, Title) => updateResourceTitle(db, Id, Title),
    findActiveBySource: (Url) => findActiveBySource(db, Url),
    softDeleteResource: (Id) => softDeleteResource(db, Id),
    findResourcesByStatus: (Status) => findResourcesByStatus(db, Status),
    countResourcesByStatus: () => countResourcesByStatus(db),

    writeChunksWithEmbeddings: (ResourceId, Chunks, Vectors) =>
      writeChunksWithEmbeddings(db, ResourceId, Chunks, Vectors),
    getChunksByResource: (ResourceId) => getChunksByResource(db, ResourceId),
    deleteChunksByResource: (ResourceId) => deleteChunksByResource(db, ResourceId),

    createSession: (Title) => createSession(db, Title),
    getSession: (Id) => getSession(db, Id),
    createMessage: (Data) => createMessage(db, Data),
    getMessagesBySession: (SessionId) => getMessagesBySession(db, SessionId),
  }
}

type RegistedProviders = Partial<Record<ProviderEntryName, ProviderV4>>

type RegistedModels = {
  languageModels: Partial<Record<LanguageModelId, LanguageModelV4>>
  embeddingModels: Partial<Record<EmbeddingModelId, EmbeddingModelV4>>
}
