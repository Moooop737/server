/**
 * 基础层唯一的对外门 —— 别盒只准从这里 import（AD-6：adapter/ 用单一 contract.ts 门，不逐盒建）。
 * 门只交服务、不交连接：new PostgresRepo(Config) 在内部造池并持有，Pool 与任何 SQL 文本都出不了 repo/（AD-3），
 * 所以这里不出现 `pg`，也没有「借一条连接」的原语可导出。
 * Repo 的方法名逐个沿用现网 Repository 的 16 个（现只剩 findResourcesByStatus 一个清理侧占位），另加五个：
 * ping / dimensionsInStore / markInterruptedAsFailed / vectorCandidates / lexicalCandidates。
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
 * · countResourcesByStatus：只数未软删，三个状态都给键（没命中补 0）；「空库 / 全无 ready」的判定归调用方。
 * · softDeleteResource：resources 留痕、chunks 物理删（embeddings 经 FK source_id→chunks.id ON DELETE CASCADE 随之消失）；
 *   返回 false = 该行不存在或早已软删。
 * · dimensionsInStore：数的是 embeddings 的维度事实，与行是否软删无关；库不可达时抛，由调用方处置（检索层每请求现查一次，见 retrieve/retrievers.ts）。
 * · updateResourceStatus / 写入路径都自带 `deleted_at IS NULL` 谓词，不由调用方拼。
 * 唯一例外：`connection/pool.ts` 的 createDbPool 被三个 gitignore 的对账脚本直接 import（它们要一条独立连接做 raw 校数），不经本门。
 * 本层的四格分工：`connection/`＝怎么连上外部服务（pg 池、Ollama 的原生地址与探活），`repo/`＝行、SQL 文本与实体形状（Resource/Chunk/Session/Message 住在产出行投影的那个文件里），`provider/`＋`model/`＝AI SDK 的网关、句柄与 embed 调用封装。
 * 实体形状不再有跨层共享盒（原 `types/` 已删）：别盒要用哪一位，由本门逐个点名交出（现交 Resource）。
 */

export {RetrieverHandle, PostgresRepo, EmbeddingHandle, ChatHandle, ollamaHealthCheck, ollamaModelList, ollamaStatusList, ModelRegistry, embedChunks }
export type { Repo, ChunkCandidate, Resource, Message, OllamaModelDetails, OllamaModelEntry, OllamaModelStatus, ProviderEntryName, LanguageModelId, EmbeddingModelId, RegistedProviders, RegistedModels }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { createDbPool, pingDb } from './connection/pool'
import {
  createResource, updateResourceStatus, updateResourceTitle, softDeleteResource, markInterruptedAsFailed,
} from './repo/write-resource'
import { writeChunksWithEmbeddings, deleteChunksByResource } from './repo/write-content'
import {
  getResource, listResources, countResourcesByStatus, findActiveBySource, getChunksByResource, dimensionsInStore,
  findResourcesByStatus, createSession, getSession, listSessions, updateSessionTitle, createMessage, getMessagesBySession,
} from './repo/read-content'
import { vectorCandidates } from './repo/search-vector'
import { lexicalCandidates } from './repo/search-lexical'
import { ollamaHealthCheck, ollamaModelList, ollamaStatusList } from './connection/ollama'
import { type ProviderEntryName } from './provider/registry'
import { ModelRegistry, type EmbeddingModelId, type LanguageModelId } from './model/registry'
import { embedChunks } from './model/embed-chunks'

import { AppConfig } from '../config'
import type { Chunk, Message, Resource, Session } from './repo/read-content'
import type { Embedding } from './repo/write-content'
import type { OllamaModelDetails, OllamaModelEntry, OllamaModelStatus } from './connection/ollama'
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
  listSessions(): Promise<Session[]>
  updateSessionTitle(SessionId: string, Title: string): Promise<Session | null>
  createMessage(Data: Pick<Message, 'session_id' | 'role' | 'content' | 'parts'>): Promise<Message>
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

@singleton()
class EmbeddingHandle {
  readonly model: EmbeddingModelV4
  readonly modelId: string
  readonly dimensions: number

  constructor(@inject(AppConfig) Config: AppConfig, @inject(ModelRegistry) Models: RegistedModels) {
    const Name = Config.embeddingModel
    if (!Object.hasOwn(Models.embeddingModels, Name)) {
      console.error(JSON.stringify({
        code: 'E_EMBEDDING_MODEL',
        message: `EMBEDDING_MODEL=${Name} 不在册；在册嵌入句柄=${Object.keys(Models.embeddingModels).join(',') || '无'}`,
      }))
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
      console.error(JSON.stringify({
        code: 'E_CHAT_MODEL',
        message: `CHAT_MODEL=${Name} 不在册；在册对话句柄=${Object.keys(Models.languageModels).join(',') || '无'}`,
      }))
      process.exit(1)
    }
    this.model = Models.languageModels[Name as LanguageModelId]!
  }
}

@singleton()
class PostgresRepo implements Repo {
  private readonly db: ReturnType<typeof createDbPool>

  constructor(@inject(AppConfig) Config: AppConfig) {
    this.db = createDbPool(Config.databaseUrl)
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
    return getResource(this.db, Id)
  }

  listResources() {
    return listResources(this.db)
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

  findResourcesByStatus(Status: Resource['status']) {
    return findResourcesByStatus(this.db, Status)
  }

  countResourcesByStatus() {
    return countResourcesByStatus(this.db)
  }

  writeChunksWithEmbeddings(
    ResourceId: string,
    Chunks: Pick<Chunk, 'chunk_index' | 'content' | 'start_offset' | 'end_offset'>[],
    Vectors: Pick<Embedding, 'dimension' | 'model' | 'embedding'>[],
  ) {
    return writeChunksWithEmbeddings(this.db, ResourceId, Chunks, Vectors)
  }

  getChunksByResource(ResourceId: string) {
    return getChunksByResource(this.db, ResourceId)
  }

  deleteChunksByResource(ResourceId: string) {
    return deleteChunksByResource(this.db, ResourceId)
  }

  createSession(Title?: string) {
    return createSession(this.db, Title)
  }

  getSession(Id: string) {
    return getSession(this.db, Id)
  }

  listSessions() {
    return listSessions(this.db)
  }

  updateSessionTitle(SessionId: string, Title: string) {
    return updateSessionTitle(this.db, SessionId, Title)
  }

  createMessage(Data: Pick<Message, 'session_id' | 'role' | 'content' | 'parts'>) {
    return createMessage(this.db, Data)
  }

  getMessagesBySession(SessionId: string) {
    return getMessagesBySession(this.db, SessionId)
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
