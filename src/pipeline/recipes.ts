/**
 * 入库配方工厂 —— 按来源种类造出「内容策略链」fetch → parse → chunk，交单执行器按此顺序跑。
 * 配方只装策略：embed 与写库经 IngestDeps 注入的端口完成，不进配方（10-10 决定：stage 文件夹只放无外部 I/O 的策略）。
 * 文本入库也过 fetch 段（PassthroughFetcher），执行器内因此不出现来源类型分支；加新来源 = 在此加一个 createXxxRecipe。
 */

import { HttpFetcher } from './fetch/http-fetcher'
import { PassthroughFetcher } from './fetch/passthrough'
import { HtmlParser } from './parse/html-parser'
import { TextParser } from './parse/text-parser'
import { LegacyChunker } from './chunk/legacy'

export { createUrlRecipe, createTextRecipe }
export type { IngestRecipe }

import type { Chunker, Fetcher, Parser } from './contracts'

interface IngestRecipe {
  fetch: Fetcher
  parse: Parser
  chunk: Chunker
}

function createUrlRecipe(): IngestRecipe {
  return { fetch: new HttpFetcher(), parse: new HtmlParser(), chunk: new LegacyChunker() }
}

function createTextRecipe(): IngestRecipe {
  return { fetch: new PassthroughFetcher(), parse: new TextParser(), chunk: new LegacyChunker() }
}
