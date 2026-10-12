import type { IngestContext, Parser } from '../contracts'

// Markdown/纯文本入库：跳过 fetch，正文原样交给 chunk（legacy 分块器已保护代码块/表格）。
// 这里只负责定标题 + 把 content 放进 ctx.parsed。
export class TextParser implements Parser {
  readonly name = 'text'

  run(ctx: IngestContext): void {
    const raw = ctx.input.content ?? ''
    const title = ctx.input.title?.trim() || deriveTitle(raw)
    ctx.parsed = { title, text: raw }
  }
}

// 标题优先级：Markdown 一级标题 > 首个非空行（去掉列表/引用/标题符号）> 兜底名
function deriveTitle(text: string): string {
  const h1 = text.match(/^[ \t]{0,3}#\s+(.+?)[ \t]*#*[ \t]*$/m)
  if (h1?.[1]) return truncate(h1[1].trim())

  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t !== '') return truncate(t.replace(/^[#>*\-\s]+/, ''))
  }
  return '未命名资源'
}

function truncate(s: string): string {
  return s.length > 60 ? s.slice(0, 60) + '…' : s
}
