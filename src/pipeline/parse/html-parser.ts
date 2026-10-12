/**
 * HTML 入库解析器 —— jsdom 解析 → Readability 抽正文 → turndown(+gfm) 转 Markdown。
 * 标题优先级：<title> > Readability article.title。
 * 解析前先 stripPageAnchors 删文档站标题旁的页内空锚点（零宽字符/# 构成，如 VitePress），否则混进正文。
 */

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

function stripPageAnchors(doc: Document): void {
    doc.querySelectorAll('a[href^="#"]').forEach((a) => {
        const text = (a.textContent ?? '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim()
        if (text === '' || text === '#') a.remove()
    })
}
