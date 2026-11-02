/**
 * 知识库资源工具 —— 按 UUID 或文件名定位资源；不给 lines 时回前 80 行预览，给 lines 时按行区间读正文。
 * 正文由 chunks 按 start_offset 拼回：URL 资源归档的是 HTML，chunks 上才是解析后文本；
 *   分块不变量 slice(start,end) === content，相邻块可能重叠，当前语料无空隙（空隙按空格补齐，保证偏移不漂）。
 * 定位：UUID 精确；否则在 title / data_uri 原始文件名 / source 三面做大小写不敏感子串匹配，
 *   文件名带扩展名时再按去扩展名搜一次；多命中回 candidates。
 * execute 的错误规矩同 retrieve：预期错误 return 结构化 error，非预期 bug 记日志后照旧抛。
 * 行区间：闭区间、1-based、可多段；排序合并重叠/相邻；越界 clamp；段数 ≤10、总行数 ≤300，超出标 truncated。
 */

export { buildResourceTool, resource }
import { fileNameFromKey, parseDataUri } from '../../../adapter/storage/uri'

import type { AgentToolEntry } from '../weave'
import type { ResourceCandidate, ResourceMeta, ResourceSegment, ResourceToolInput, ResourceToolOutput } from '../contracts'
import type { Chunk } from '../../../adapter/repo/chunk'
import type { Resource } from '../../../adapter/repo/resource'
import { type Tool, tool } from 'ai'
import { z } from 'zod'
import { logError } from '../../../trace/systemtrace/log'

const MAX_SEGMENTS = 10
const MAX_TOTAL_LINES = 300
const MAX_CANDIDATES = 20
const PREVIEW_LINES = 80
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ResourceReadPort {
    getResource(Id: string): Promise<Resource | null>
    searchResources(Query: string, Limit: number): Promise<Resource[]>
    listChunksByResource(ResourceId: string): Promise<Chunk[]>
}

interface LineRange {
    from: number
    to: number
}

function resource(Repo: ResourceReadPort): AgentToolEntry {
    return {
        name: 'resource',
        catalog: 'read a specific document by UUID or file name, optionally specific line ranges',
        instruction: 'When the retrieve hits are not enough, or you need a whole document or a specific part of it, call resource with the document id or file name. Without lines it returns the first 80 lines as a preview; pass lines as inclusive 1-based ranges, e.g. [[10,20],[30,80]], for a specific range. If resource returns candidates, pick one by id or a more specific name and call again. If resource returns an error, repeat the error message verbatim.',
        tool: buildResourceTool(Repo),
    }
}

function buildResourceTool(Repo: ResourceReadPort): Tool<ResourceToolInput, ResourceToolOutput> {
    return tool({
        description: 'Read a knowledge-base resource by UUID or file name. With `lines`, returns those line ranges; without, returns the first 80 lines as a preview. Use it to inspect a whole document or a specific part of it.',
        inputSchema: z.object({
            ref: z.string().min(1).describe('resource UUID, or a file name / title / source URL substring'),
            lines: z.array(z.tuple([z.number().int().min(1), z.number().int().min(1)]))
                .max(MAX_SEGMENTS)
                .optional()
                .describe('inclusive 1-based line ranges, e.g. [[10,20],[30,80]]; omit for a first-80-lines preview')
        }),
        execute: async (Input: ResourceToolInput) => {
            try {
                return await read(Repo, Input)
            } catch (err) {
                logError('E_TOOL_RESOURCE', String(err))
                throw err
            }
        }
    })

}

async function read(Repo: ResourceReadPort, Input: ResourceToolInput): Promise<ResourceToolOutput> {
    const ref = Input.ref.trim()
    if (ref === '') return fail('E_BAD_REF', 'ref 不能为空')

    const ranges = Input.lines ?? []
    if (ranges.length > 0 && !validRanges(ranges)) {
        return fail('E_BAD_LINES', 'lines 需为 [from, to] 闭区间，from ≥ 1 且 from ≤ to')
    }

    let target: Resource
    if (UUID.test(ref)) {
        const found = await Repo.getResource(ref)
        if (found === null) return fail('E_RESOURCE_NOT_FOUND', `资源不存在或已删除: ${ref}`)
        target = found
    } else {
        const found = await searchByRef(Repo, ref)
        if (found.length === 0) return fail('E_RESOURCE_NOT_FOUND', `没有标题、文件名或来源包含「${ref}」的资源`)
        if (found.length > 1) {
            return { resource: null, candidates: found.map(toCandidate), content: null, error: null }
        }
        target = found[0]!
    }

    if (target.status !== 'ready') {
        return {
            resource: toMeta(target, 0),
            candidates: null,
            content: null,
            error: { code: 'E_NOT_READY', message: `资源状态为 ${target.status}，尚无正文` },
        }
    }

    const chunks = await Repo.listChunksByResource(target.id)
    if (chunks.length === 0) {
        return { resource: toMeta(target, 0), candidates: null, content: null, error: { code: 'E_NO_CONTENT', message: '资源没有可读正文' } }
    }

    const lines = joinChunks(chunks).split('\n')
    const preview = ranges.length === 0
    const wanted: [number, number][] = preview ? [[1, PREVIEW_LINES]] : ranges
    const sliced = sliceRanges(normalizeRanges(wanted, lines.length), lines)
    return {
        resource: toMeta(target, chunks.length),
        candidates: null,
        content: {
            segments: sliced.segments,
            totalLines: lines.length,
            truncated: sliced.truncated || (preview && lines.length > PREVIEW_LINES),
        },
        error: null,
    }
}

async function searchByRef(Repo: ResourceReadPort, Ref: string): Promise<Resource[]> {
    const seen = new Map<string, Resource>()
    for (const query of queriesOf(Ref)) {
        for (const item of await Repo.searchResources(query, MAX_CANDIDATES)) seen.set(item.id, item)
        if (seen.size >= MAX_CANDIDATES) break
    }
    return [...seen.values()].slice(0, MAX_CANDIDATES)
}

function queriesOf(Ref: string): string[] {
    const dot = Ref.lastIndexOf('.')
    if (dot <= 0 || Ref.includes('/')) return [Ref]
    const stem = Ref.slice(0, dot).trim()
    return stem === '' || stem === Ref ? [Ref] : [Ref, stem]
}

function validRanges(Ranges: [number, number][]): boolean {
    return Ranges.every(([From, To]) => Number.isInteger(From) && Number.isInteger(To) && From >= 1 && To >= From)
}

function toMeta(ResourceRow: Resource, ChunkCount: number): ResourceMeta {
    return {
        id: ResourceRow.id,
        title: ResourceRow.title,
        fileName: fileNameOf(ResourceRow),
        source: ResourceRow.source,
        status: ResourceRow.status,
        content_type: ResourceRow.content_type,
        size: ResourceRow.storage_size_bytes,
        created_at: ResourceRow.created_at,
        updated_at: ResourceRow.updated_at,
        error_reason: ResourceRow.error_reason,
        chunkCount: ChunkCount,
        ref: `file:resource/${ResourceRow.id}`,
    }
}

function toCandidate(ResourceRow: Resource): ResourceCandidate {
    return {
        id: ResourceRow.id,
        title: ResourceRow.title,
        fileName: fileNameOf(ResourceRow),
        source: ResourceRow.source,
        status: ResourceRow.status,
        created_at: ResourceRow.created_at,
        ref: `file:resource/${ResourceRow.id}`,
    }
}

function fail(Code: string, Message: string): ResourceToolOutput {
    return { resource: null, candidates: null, content: null, error: { code: Code, message: Message } }
}

function joinChunks(Chunks: Chunk[]): string {
    const ordered = [...Chunks].sort((A, B) => A.chunk_index - B.chunk_index)
    let text = ''
    let cursor = 0
    for (const Chunk of ordered) {
        if (Chunk.start_offset === null || Chunk.end_offset === null) {
            text += Chunk.content
            cursor = text.length
            continue
        }
        if (Chunk.start_offset > cursor) text += ' '.repeat(Chunk.start_offset - cursor)
        const skip = Math.max(0, cursor - Chunk.start_offset)
        text += Chunk.content.slice(skip)
        cursor = Math.max(cursor, Chunk.end_offset)
    }
    return text
}

function normalizeRanges(Ranges: [number, number][], TotalLines: number): LineRange[] {
    const clamped = Ranges
        .map(([From, To]) => ({ from: Math.max(1, Math.min(From, TotalLines)), to: Math.max(1, Math.min(To, TotalLines)) }))
        .filter((Range) => Range.from <= Range.to)
        .sort((A, B) => A.from - B.from)
    const merged: LineRange[] = []
    for (const Range of clamped) {
        const last = merged[merged.length - 1]
        if (last !== undefined && Range.from <= last.to + 1) last.to = Math.max(last.to, Range.to)
        else merged.push({ ...Range })
    }
    return merged
}

function sliceRanges(Ranges: LineRange[], Lines: string[]): { segments: ResourceSegment[]; truncated: boolean } {
    const segments: ResourceSegment[] = []
    let remaining = MAX_TOTAL_LINES
    let truncated = false
    for (const Range of Ranges) {
        if (segments.length >= MAX_SEGMENTS || remaining <= 0) {
            truncated = true
            break
        }
        const length = Range.to - Range.from + 1
        const take = Math.min(length, remaining)
        const to = Range.from + take - 1
        if (take < length) truncated = true
        segments.push({ fromLine: Range.from, toLine: to, text: numbered(Lines, Range.from, to) })
        remaining -= take
    }
    return { segments, truncated }
}

function numbered(Lines: string[], From: number, To: number): string {
    return Lines.slice(From - 1, To)
        .map((Line, Index) => `${From + Index}\t${Line}`)
        .join('\n')
}

function fileNameOf(ResourceRow: Resource): string {
    let name = ResourceRow.title
    try {
        name = fileNameFromKey(parseDataUri(ResourceRow.data_uri).key)
    } catch {
        /* data_uri 坏了就退回 title；展示名不值得让工具失败 */
    }
    if (name.includes('.')) return name
    const ext = ResourceRow.content_type === 'text/html' ? '.html' : ResourceRow.content_type === 'text/markdown' ? '.md' : '.txt'
    return `${name}${ext}`
}