/**
 * 文本入库解析器 —— 跳过 fetch，正文原样交 chunk（legacy 分块器已保护代码块/表格）；只定标题 + 填 ctx.parsed。
 * 标题优先级：Markdown 一级标题 > 首个非空行（去列表/引用/标题符号）> 兜底名「未命名资源」。
 */

import type { IngestContext, Parser } from '../contracts'

export class TextParser implements Parser {
  readonly name = 'text'

  run(ctx: IngestContext): void {
    const raw = ctx.input.content ?? ''
    const title = ctx.input.title?.trim() || deriveTitle(raw)
    ctx.parsed = { title, text: raw }
  }
}

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
