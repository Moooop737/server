import type { ChunkPlan, Chunker, IngestContext } from '../contracts'
import { resolveChunkerConfig, type ChunkerConfig, type ResolvedChunkerConfig } from './config'
import { protectedSpans, type Span } from './protected'

// WeKnora legacy SplitText 的 TS 移植（保真度 A）。三阶段：
//   ① 按分隔符优先级递归切细  ② 保护段整块留住  ③ 装箱 + 语义重叠
// 全程只用 JS 字符串索引；不变量：text.slice(start,end) === content。
// 未移植（P2 再议）：表格表头跨块延续 headerTracker、token 预算钳制、parent-child 父子块。

const ABSOLUTE_MAX_SIZE = 7500 // 超过它才允许把"不可切的内容"强行切开
const FORCE_SPLIT_LOOKBACK = 200 // 强切时往回找换行/空格的最远距离

// 一个切分单元：原文里的一段连续字符
interface SplitUnit {
  text: string
  start: number
  end: number
}

interface RawChunk {
  content: string
  start: number
  end: number
}

// ── ① 按分隔符优先级递归切分 ──

export function splitBySeparators(text: string, separators: string[], chunkSize: number): string[] {
  if (!text || separators.length === 0) return [text]
  if (chunkSize > 0 && text.length <= chunkSize) return [text]

  for (let i = 0; i < separators.length; i++) {
    const sep = separators[i]
    if (!sep) continue

    const pieces = splitKeepingSeparator(text, sep)
    if (pieces.length <= 1) continue // 这条分隔符不存在，降级到下一条

    // 下钻只准用"剩下的低优先级分隔符"；若允许回头用同一条，会无限递归
    const deeper = separators.slice(i + 1)
    const out: string[] = []
    for (const p of pieces) {
      if (chunkSize > 0 && p.length > chunkSize && deeper.length > 0) {
        out.push(...splitBySeparators(p, deeper, chunkSize))
      } else {
        out.push(p)
      }
    }
    return out
  }

  return [text] // 分隔符用尽仍超长：认了，交给装箱阶段处理
}

// 切开，但把分隔符本身也留在流里单独成一片 —— 所有片拼回去 == 原文
function splitKeepingSeparator(text: string, sep: string): string[] {
  const first = text.indexOf(sep)
  if (first === -1) return [text]

  const pieces: string[] = []
  let pos = 0
  let idx = first
  while (idx !== -1) {
    if (idx > pos) pieces.push(text.slice(pos, idx))
    pieces.push(sep)
    pos = idx + sep.length
    idx = text.indexOf(sep, pos)
  }
  if (pos < text.length) pieces.push(text.slice(pos))
  return pieces
}

// ── ② 保护段：段内整块不动，段间才切细 ──

function buildUnits(text: string, cfg: ResolvedChunkerConfig): SplitUnit[] {
  const spans = protectedSpans(text)
  const units: SplitUnit[] = []

  const splitRegion = (from: number, to: number) => {
    if (to <= from) return
    const region = text.slice(from, to)
    let off = from
    for (const part of splitBySeparators(region, cfg.separators, cfg.chunkSize)) {
      units.push({ text: part, start: off, end: off + part.length })
      off += part.length
    }
  }

  let pos = 0
  for (const s of spans) {
    splitRegion(pos, s.start)
    const prot = text.slice(s.start, s.end)
    if (prot.length > ABSOLUTE_MAX_SIZE) units.push(...forceSplit(prot, s.start))
    else units.push({ text: prot, start: s.start, end: s.end })
    pos = s.end
  }
  splitRegion(pos, text.length)

  return units
}

// 绝对超长才走这里：在 maxSize 附近往回找换行/空格当切点
function forceSplit(text: string, base: number, maxSize = ABSOLUTE_MAX_SIZE): SplitUnit[] {
  const out: SplitUnit[] = []
  let off = 0

  while (off < text.length) {
    let end = Math.min(off + maxSize, text.length)
    if (end < text.length) {
      const floor = Math.max(off + 1, end - FORCE_SPLIT_LOOKBACK)
      for (let i = end - 1; i > floor; i--) {
        if (text[i] === '\n' || text[i] === ' ') {
          end = i + 1
          break
        }
      }
    }
    const piece = text.slice(off, end)
    out.push({ text: piece, start: base + off, end: base + end })
    off = end
  }

  return out
}

// ── ③ 装箱 + 语义重叠 ──

function mergeUnits(units: SplitUnit[], cfg: ResolvedChunkerConfig): RawChunk[] {
  const { chunkSize, chunkOverlap } = cfg
  const chunks: RawChunk[] = []
  let current: SplitUnit[] = []
  let curLen = 0

  for (const u of units) {
    const uLen = u.text.length

    if (uLen > ABSOLUTE_MAX_SIZE) {
      if (current.length > 0) {
        chunks.push(buildChunk(current))
        current = []
        curLen = 0
      }
      for (const piece of forceSplit(u.text, u.start)) chunks.push(buildChunk([piece]))
      continue
    }

    // 交出去之前必须判 current 非空：否则单个超长单元会反复交出空块
    if (curLen + uLen > chunkSize && current.length > 0) {
      chunks.push(buildChunk(current))
      const kept = computeOverlap(current, chunkOverlap, chunkSize, uLen)
      current = kept ? [kept] : []
      curLen = kept ? kept.text.length : 0
    }

    if (curLen + uLen > ABSOLUTE_MAX_SIZE && current.length > 0) {
      chunks.push(buildChunk(current))
      current = []
      curLen = 0
    }

    current.push(u)
    curLen += uLen
  }

  if (current.length > 0) chunks.push(buildChunk(current))
  return chunks
}

// 只在 units 非空时调用：start 取第一个单元、end 取最后一个单元
function buildChunk(units: SplitUnit[]): RawChunk {
  let content = ''
  let start = 0
  let end = 0
  let first = true
  for (const u of units) {
    if (first) {
      start = u.start
      first = false
    }
    end = u.end
    content += u.text
  }
  return { content, start, end }
}

// 交出上一块后，从它尾巴留一点当下一块的上下文
function computeOverlap(
  current: SplitUnit[],
  chunkOverlap: number,
  chunkSize: number,
  nextLen: number,
): SplitUnit | null {
  if (chunkOverlap <= 0 || current.length === 0) return null

  // 重叠是要占下一块容量的，留满了就塞不进新单元
  const budget = Math.min(chunkOverlap, chunkSize - nextLen)
  if (budget <= 0) return null

  const doc = current.map((u) => u.text).join('')
  let docEnd = 0
  for (const u of current) docEnd = u.end
  const boundary = findSemanticBoundary(doc, Math.max(0, doc.length - budget))
  if (boundary < 0) return null

  const overlapText = doc.slice(boundary)
  if (overlapText.length === 0 || overlapText.length > budget || overlapText.trim() === '') return null

  // start 由 end 反推，唯一目的是让 slice(start,end) 精确等于这段文本；另算起点早晚会错位
  return { text: overlapText, start: docEnd - overlapText.length, end: docEnd }
}

interface Boundary {
  end: number
  priority: number
}

// 段落界 > 行界 > 句界；同优先级取最早的那个
function findSemanticBoundary(doc: string, minEnd: number): number {
  const spans = protectedSpans(doc)
  const candidates: Boundary[] = []
  collect(/\r?\n[ \t]*\r?\n/g, 0)
  collect(/\r?\n/g, 1)
  collect(/[。？！]/g, 2)
  collect(/[.?!](?=\s)/g, 2)

  let best = -1
  let bestPriority = Number.MAX_SAFE_INTEGER
  for (const c of candidates) {
    if (c.end < minEnd || c.end >= doc.length) continue // 边界后没内容，切了没意义
    if (doc.slice(c.end).trim() === '') continue
    if (insideSpan(spans, c.end - 1)) continue // 分隔符本身在保护段里（如代码块内的换行）
    if (c.priority < bestPriority || (c.priority === bestPriority && (best === -1 || c.end < best))) {
      bestPriority = c.priority
      best = c.end
    }
  }
  return best

  function collect(re: RegExp, priority: number) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(doc)) !== null) {
      candidates.push({ end: m.index + m[0].length, priority })
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }
}

function insideSpan(spans: Span[], pos: number): boolean {
  for (const s of spans) {
    if (pos < s.start) return false
    if (pos < s.end) return true
  }
  return false
}

// ── 对外入口 ──

export function legacySplit(text: string, cfg: ResolvedChunkerConfig): ChunkPlan[] {
  if (!text) return []
  const units = buildUnits(text, cfg)
  if (units.length === 0) return []

  // 纯空白的块对 embed 没价值、还白占一条向量，丢掉后重新编号。
  // offset 保持指向原文原位置（内容 verbatim 的不变量不动），所以整篇空白时返回 0 块
  // → 上层据此置 失败(内容为空)，正是 Story 1.2 AC 要求的路径。
  return mergeUnits(units, cfg)
    .filter((c) => c.content.trim() !== '')
    .map((c, i) => ({
      chunk_index: i,
      content: c.content,
      start_offset: c.start,
      end_offset: c.end,
      strategy: 'legacy',
    }))
}

export class LegacyChunker implements Chunker {
  readonly name = 'legacy'
  private readonly cfg: ResolvedChunkerConfig

  constructor(config: ChunkerConfig = {}) {
    this.cfg = resolveChunkerConfig(config)
  }

  run(ctx: IngestContext): void {
    ctx.chunks = legacySplit(ctx.parsed?.text ?? '', this.cfg)
  }
}
