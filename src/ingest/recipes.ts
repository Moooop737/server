/**
 * stage 注册表 —— 名字→构造函数 的目录，工厂据此把 Recipe 里的策略名兑换成实例。
 * 纯目录：无来源分支；查无（含 Object.prototype 上的名字，如 'toString'/'constructor'）一律返回 undefined，校验交工厂抛 E_UNKNOWN_STAGE。
 * http/passthrough/parser/chunker 不吃构造参数；storage 需要注入 ObjectStore 与桶名。
 * embed 不在这张表里 —— 它是装配层从 model 清单选定的那一行句柄，随 Recipe.embedding 进来，不是可换的策略。
 */

import { HttpFetcher } from './fetch/http-fetcher'
import { PassthroughFetcher } from './fetch/passthrough'
import { StorageFetcher } from './fetch/storage-fetcher'
import { HtmlParser } from './parse/html-parser'
import { TextParser } from './parse/text-parser'
import { LegacyChunker } from './chunk/legacy'

export { createStageRegistry }

import type { StageRegistry, Fetcher, Parser, Chunker } from './contracts'
import type { ObjectStore } from '../adapter/contract'

function createStageRegistry(Store: ObjectStore, Bucket: string): StageRegistry {
  const fetchers: Record<string, () => Fetcher> = {
    http: () => new HttpFetcher(),
    passthrough: () => new PassthroughFetcher(),
    storage: () => new StorageFetcher(Store, Bucket),
  }
  const parsers: Record<string, () => Parser> = {
    html: () => new HtmlParser(),
    text: () => new TextParser(),
  }
  const chunkers: Record<string, () => Chunker> = {
    legacy: () => new LegacyChunker(),
  }
  return {
    fetcher: (Name) => instantiate(fetchers, Name),
    parser: (Name) => instantiate(parsers, Name),
    chunker: (Name) => instantiate(chunkers, Name),
  }
}

function instantiate<T>(Table: Record<string, () => T>, Name: string): T | undefined {
  return Object.hasOwn(Table, Name) ? Table[Name]!() : undefined
}
