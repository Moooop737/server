// 移植 WeKnora splitter.go 的 protectedPatterns + protectedSpans。
// 保护段 = 切块时不许被拦腰切断的内容：LaTeX 块、MD 图片/链接、表格、围栏代码、行内代码。
// 偏移单位 = JS 字符串索引，与 ChunkPlan.start_offset 同一空间。

export interface Span {
  start: number
  end: number
}

// Go 的 (?s) 用 [\s\S] 表达跨行；(?m) 在这几条里没有 ^/$，省略。
// 统一带 g 标志，好让 exec 逐次取到每处匹配的 index。
const PROTECTED_PATTERNS: RegExp[] = [
  /\$\$[\s\S]*?\$\$/g, // 块级 LaTeX
  /!\[[^\]\n]{0,200}\]\([^)\n]{1,500}\)/g, // Markdown 图片
  /\[[^\]\n]{1,200}\]\([^)\n]{1,500}\)/g, // Markdown 链接
  /[ ]*(?:\|[^|\n]*)+\|[\r\n]+\s*(?:\|\s*:?-{3,}:?\s*)+\|[\r\n]+/g, // 表头 + 分隔行
  /[ ]*(?:\|[^|\n]*)+\|[\r\n]+/g, // 表格行
  /```(?:\w+)?[\r\n][\s\S]*?```/g, // 围栏代码块
  /`[^`\r\n]+`/g, // 行内代码
]

// 找出所有互不重叠的保护段：收集 → 按 start 升序（同 start 时长者胜）→ 丢掉交叠的。
export function protectedSpans(text: string): Span[] {
  const all: Span[] = []

  for (const re of PROTECTED_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[0].length > 0) all.push({ start: m.index, end: m.index + m[0].length })
      if (m.index === re.lastIndex) re.lastIndex++ // 防零宽匹配死循环
    }
  }

  if (all.length === 0) return []

  all.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))

  const merged: Span[] = []
  let lastEnd = 0
  for (const s of all) {
    if (s.start >= lastEnd) {
      merged.push(s)
      lastEnd = s.end
    }
  }
  return merged
}
