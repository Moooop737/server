export type { Resource, Chunk, Embedding, Session, Message, CitationSource }

interface timestamp {
    created_at: string,
    updated_at: string,
    deleted_at: string | null
}

interface Resource extends timestamp {
    id: string
    title: string
    source: string | null
    data_uri: string
    content_type: 'url' | 'markdown' | 'plaintext'
    status: 'processing' | 'ready' | 'failed'
    error_reason: string | null
}

interface Chunk extends timestamp {
    id: string
    resource_id: string
    resource_uri: string
    chunk_index: number
    content: string
    start_offset: number | null
    end_offset: number | null
}

interface Embedding extends timestamp {
    id: string
    source_id: string
    source_type: 'chunk'
    dimension: number
    model: string
    embedding: number[]
}

interface Session extends timestamp {
    id: string
    title: string
    user_id: string
}

interface Message extends timestamp {
    id: string
    session_id: string
    role: 'user' | 'assistant' | 'tool'
    content: string
    sources: CitationSource[] | null
}

interface CitationSource {
    marker: string
    chunk_id: string
    doc_title: string
    data_uri: string
    source: string | null
    snippet: string
}