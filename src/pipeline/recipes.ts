/**
 * stage 注册表 —— 名字→构造函数 的目录，工厂据此把 Recipe 里的策略名兑换成实例。
 * 纯目录：无来源分支；查无（含 Object.prototype 上的名字，如 'toString'/'constructor'）一律返回 undefined，校验交工厂抛 E_UNKNOWN_STAGE。
 * embedder 也在表内：名字位是校验位不是选择位（全库只允许一个 embedding 模型），P1 只有 qwenembed 一项，构造时需要 config 的 baseUrl/model/dimensions；其余策略 P1 不消费 config。
 */

import { HttpFetcher } from './fetch/http-fetcher'
import { PassthroughFetcher } from './fetch/passthrough'
import { HtmlParser } from './parse/html-parser'
import { TextParser } from './parse/text-parser'
import { LegacyChunker } from './chunk/legacy'
import { QwenEmbedder } from './embed/qwenembed'

export { createStageRegistry }

import type { StageRegistry, PipelineConfig, Fetcher, Parser, Chunker } from './contracts'
import type { Embedder } from '../ports/embedder'

function createStageRegistry(): StageRegistry {
  const fetchers: Record<string, (c: PipelineConfig) => Fetcher> = {
    http: () => new HttpFetcher(),
    passthrough: () => new PassthroughFetcher(),
  }
  const parsers: Record<string, (c: PipelineConfig) => Parser> = {
    html: () => new HtmlParser(),
    text: () => new TextParser(),
  }
  const chunkers: Record<string, (c: PipelineConfig) => Chunker> = {
    legacy: () => new LegacyChunker(),
  }
  const embedders: Record<string, (c: PipelineConfig) => Embedder> = {
    qwenembed: (c) => new QwenEmbedder(c),
  }
  return {
    fetcher: (Name, Config) => instantiate(fetchers, Name, Config),
    parser: (Name, Config) => instantiate(parsers, Name, Config),
    chunker: (Name, Config) => instantiate(chunkers, Name, Config),
    embedder: (Name, Config) => instantiate(embedders, Name, Config),
  }
}

function instantiate<T>(Table: Record<string, (c: PipelineConfig) => T>, Name: string, Config: PipelineConfig): T | undefined {
  return Object.hasOwn(Table, Name) ? Table[Name]!(Config) : undefined
}
