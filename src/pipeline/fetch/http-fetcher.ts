/**
 * HTTP 抓取器 —— GET ctx.input.url，仅允许 http/https，正文塞进 ctx.fetched.raw。
 * 失败（缺 url / 非 http(s) / 非 2xx）直接抛错，由 runIngest 的失败语义接住转 failed。
 */

import type { Fetcher, IngestContext } from '../contracts'

export class HttpFetcher implements Fetcher {
  readonly name = 'http'

  async run(ctx: IngestContext, signal?: AbortSignal): Promise<void> {
    const url = ctx.input.url
    if (!url) throw new Error('缺少 url')
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      throw new Error('仅支持 http/https')

    const res = await fetch(u, {
      signal: signal ?? null,
      headers: { 'User-Agent': 'Mozilla/5.0 (KnowledgeCopilot)' },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`抓取失败 HTTP ${res.status}`)

    const raw = await res.text()
    ctx.fetched = { raw }
  }
}
