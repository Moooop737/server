import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import type { IngestContext, Parser } from '../contracts'

export class HtmlParser implements Parser {

    readonly name = 'html';

    run(ctx: IngestContext): void {

        const raw = ctx.fetched?.raw ?? ''
        if (raw.trim() === '') { ctx.parsed = { title: '未命名资源', text: '' }; return }

        const dom = new JSDOM(raw, { url: ctx.input.url })
        const doc = dom.window.document
        stripPageAnchors(doc)
        const doc_title = doc.querySelector('title')?.textContent?.trim() ?? ''
        const article = new Readability(doc).parse()
        const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' })
        td.use(gfm)

        const title = doc_title || article?.title?.trim() || ''
        const text = article ? td.turndown(article.content ?? '') : ''
        ctx.parsed = { title, text }

    }
}

// 文档站标题旁的页内锚点（文本只有零宽字符或井号，如 VitePress 的 [​](#x)）属噪音，解析前从 DOM 删除
function stripPageAnchors(doc: Document): void {
    doc.querySelectorAll('a[href^="#"]').forEach((a) => {
        const text = (a.textContent ?? '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim()
        if (text === '' || text === '#') a.remove()
    })
}