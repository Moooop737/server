/**
 * HTTP 抓取器 —— GET ctx.data.url，仅允许 http/https，正文塞进 ctx.fetched.raw。
 * 取消信号与自带的 FETCH_TIMEOUT_MS 超时合成一个信号，任一触发即中断请求与正文读取（挂住的外站不该占着请求不放）。
 * 失败（缺 url / 非 http(s) / 非 2xx）直接抛错，由管线的失败语义接住转 failed。
 */

import type { Fetcher, IngestContext } from '../contracts'

const FETCH_TIMEOUT_MS = 30_000

export class HttpFetcher implements Fetcher {
  readonly name = 'http'

  async run(ctx: IngestContext, signal?: AbortSignal): Promise<void> {
    const url = ctx.data.url
    if (!url) throw new Error('缺少 url')
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      throw new Error('仅支持 http/https')

    const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)]
    if (signal) signals.push(signal)

    const res = await fetch(u, {
      signal: AbortSignal.any(signals),
      headers: { 'User-Agent': 'Mozilla/5.0 (KnowledgeCopilot)' },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`抓取失败 HTTP ${res.status}`)

    const raw = await res.text()
    ctx.fetched = { raw }
  }
}
