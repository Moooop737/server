import type { Resource, Chunk, Embedding, Session, Message } from '../types'

export interface Repository {
  // ── Resource ──
  createResource(
    data: Pick<Resource, 'title' | 'source' | 'data_uri' | 'content_type'> &
      Partial<Pick<Resource, 'status'>>
  ): Promise<Resource>
  getResource(id: string): Promise<Resource | null>
  listResources(): Promise<Resource[]>
  updateResourceStatus(id: string, status: Resource['status'], reason?: string): Promise<void>
  softDeleteResource(id: string): Promise<void>
  findResourcesByStatus(status: Resource['status']): Promise<Resource[]>

  // ── Chunk ──
  createChunks(
    resourceId: string,
    chunks: Pick<Chunk, 'chunk_index' | 'content' | 'start_offset' | 'end_offset'>[]
  ): Promise<Chunk[]>
  getChunksByResource(resourceId: string): Promise<Chunk[]>
  deleteChunksByResource(resourceId: string): Promise<void>

  // ── Embedding ──
  createEmbeddings(
    embeddings: Pick<Embedding, 'source_id' | 'source_type' | 'dimension' | 'model' | 'embedding'>[]
  ): Promise<void>
  deleteEmbeddingsByResource(resourceId: string): Promise<void>

  // ── Session / Message ──
  createSession(title?: string): Promise<Session>
  getSession(id: string): Promise<Session | null>
  createMessage(
    data: Pick<Message, 'session_id' | 'role' | 'content' | 'sources'>
  ): Promise<Message>
  getMessagesBySession(sessionId: string): Promise<Message[]>
}