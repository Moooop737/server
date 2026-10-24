/**
 * 直通抓取器 —— 把已在请求体里的文本塞进 ctx.fetched，让文本入库走与 URL 完全相同的 fetch→parse→chunk 链。
 * 不发任何网络请求；raw 取 ctx.data.content（缺省当空串处理，由下游判空）。标题不进这里：ctx.data.title 原样留给 parse 段。
 */

import type { Fetcher, IngestContext } from '../contracts'

export class PassthroughFetcher implements Fetcher {
  readonly name = 'passthrough'

  async run(ctx: IngestContext): Promise<void> {
    ctx.fetched = {
      raw: ctx.data.content ?? '',
      content_type: ctx.data.content_type,
      ...(ctx.data.url ? { final_url: ctx.data.url } : {}),
    }
  }
}
