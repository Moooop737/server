import type { Resource, Chunk, Embedding, Session, Message } from '../types/types'

export interface Repository {
  // ── Resource ──
  createResource(
    data: Pick<Resource, 'title' | 'source' | 'data_uri' | 'content_type'> &
      Partial<Pick<Resource, 'status'>>
  ): Promise<Resource>
  getResource(id: string): Promise<Resource | null>
  listResources(): Promise<Resource[]>
  updateResourceStatus(id: string, status: Resource['status'], reason?: string): Promise<void>
  updateResourceTitle(Id: string, Title: string): Promise<void>
  findActiveBySource(Url: string): Promise<Resource | null> // status ∈ ready/processing 且未软删
  softDeleteResource(id: string): Promise<boolean>
  findResourcesByStatus(status: Resource['status']): Promise<Resource[]>
  // 只数未软删的行；三个状态都给键（没命中补 0）。端口只报事实，「空库 / 全无 ready」的判定归调用方。
  countResourcesByStatus(): Promise<Record<Resource['status'], number>>

  // ── Chunk + Embedding（同事务写，并把行一起转 ready）──
  writeChunksWithEmbeddings(
    ResourceId: string,
    Chunks: Pick<Chunk, 'chunk_index' | 'content' | 'start_offset' | 'end_offset'>[],
    Vectors: Pick<Embedding, 'dimension' | 'model' | 'embedding'>[], // 与 Chunks 同序等长（调用方 pipelines 已判长度）
  ): Promise<number> // 返回写入 chunk 数；ready 与数据同事务，不存在「向量已落、行还 processing」
  getChunksByResource(resourceId: string): Promise<Chunk[]>
  deleteChunksByResource(resourceId: string): Promise<void> // embeddings 经 FK source_id→chunks.id ON DELETE CASCADE 随之消失

  // ── Session / Message ──（原样不动）
  createSession(title?: string): Promise<Session>
  getSession(id: string): Promise<Session | null>
  createMessage(data: Pick<Message, 'session_id' | 'role' | 'content' | 'sources'>): Promise<Message>
  getMessagesBySession(sessionId: string): Promise<Message[]>
}
