export type { Resource, Chunk, Embedding, Session, Message, CitationSource }

// 时间字段是 API 视图：统一用 ISO 8601 字符串。
// pg 驱动读回 timestamptz 是 Date 实例，由 Repository 适配器转 .toISOString()；deleted_at 为 NULL 时给 null。
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
    // 端口层契约：传/收都是 number[]。
    // halfvec 在 pg 里读回是字符串 "[1,2,3]"、写入需 '[1,2,3]' 字面量（或 setTypeParser）；
    // number[] ↔ halfvec 字符串的转换归 Repository 适配器，不在端口暴露 pg 驱动细节。
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