/**
 * 从运行时快照造 provider 客户端 —— AD-4 的唯一造客户端处。
 * 只吃纯数据，不读 env / DB；skip 不可用 provider。
 * headers 传给工厂；query：OpenAI 兼容走原生 queryParams，其余走 fetch 包装。
 * options 只取 JSON 可序列化的工厂选项；函数/客户端对象不入库。
 */

export { buildProviderHandles }

import { createAlibaba } from '@ai-sdk/alibaba'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOllama } from 'ai-sdk-ollama'
import type { ProviderV4 } from '@ai-sdk/provider'
import type { RuntimeProvider } from '../config/runtime'

type FetchLike = (Input: RequestInfo | URL, Init?: RequestInit) => Promise<Response>

function buildProviderHandles(RuntimeProviders: RuntimeProvider[]): Map<string, ProviderV4> {
  const Out = new Map<string, ProviderV4>()
  for (const Provider of RuntimeProviders) {
    if (!Provider.available) continue

    if (Provider.kind === 'deepseek') {
      Out.set(Provider.name, createDeepSeek(networkSettings(Provider)))
      continue
    }

    if (Provider.kind === 'dashscope') {
      Out.set(Provider.name, createAlibaba({
        ...networkSettings(Provider),
        ...alibabaOptions(Provider.options),
      }))
      continue
    }

    if (Provider.kind === 'ollama') {
      Out.set(Provider.name, createOllama({
        ...(Provider.base_url === null ? {} : { baseURL: Provider.base_url }),
        ...(Provider.api_key === null ? {} : { apiKey: Provider.api_key }),
        ...(Object.keys(Provider.headers).length === 0 ? {} : { headers: Provider.headers }),
        ...(Object.keys(Provider.query).length === 0 ? {} : { fetch: withQuery(Provider.query) }),
      }))
      continue
    }

    if (Provider.base_url === null) continue
    Out.set(Provider.name, createOpenAICompatible({
      name: Provider.name,
      baseURL: Provider.base_url,
      ...(Provider.api_key === null ? {} : { apiKey: Provider.api_key }),
      ...(Object.keys(Provider.headers).length === 0 ? {} : { headers: Provider.headers }),
      ...(Object.keys(Provider.query).length === 0 ? {} : { queryParams: Provider.query }),
      ...compatibleOptions(Provider.options),
    }))
  }
  return Out
}

function networkSettings(Provider: RuntimeProvider) {
  return {
    ...(Provider.api_key === null ? {} : { apiKey: Provider.api_key }),
    ...(Provider.base_url === null ? {} : { baseURL: Provider.base_url }),
    ...(Object.keys(Provider.headers).length === 0 ? {} : { headers: Provider.headers }),
    ...(Object.keys(Provider.query).length === 0 ? {} : { fetch: withQuery(Provider.query) }),
  }
}

function alibabaOptions(Options: Record<string, unknown>) {
  return {
    ...(typeof Options.includeUsage === 'boolean' ? { includeUsage: Options.includeUsage } : {}),
    ...(typeof Options.videoBaseURL === 'string' ? { videoBaseURL: Options.videoBaseURL } : {}),
    ...(typeof Options.embeddingBaseURL === 'string' ? { embeddingBaseURL: Options.embeddingBaseURL } : {}),
  }
}

function compatibleOptions(Options: Record<string, unknown>) {
  return {
    ...(typeof Options.includeUsage === 'boolean' ? { includeUsage: Options.includeUsage } : {}),
    ...(Options.supportsStructuredOutputs === true ? { supportsStructuredOutputs: true } : {}),
    ...(Options.supportsMultiPartToolContent === true ? { supportsMultiPartToolContent: true } : {}),
  }
}

function withQuery(Query: Record<string, string>): FetchLike {
  const BaseFetch = globalThis.fetch
  return (Input, Init) => {
    const Url = new URL(Input instanceof Request ? Input.url : Input.toString())
    for (const [Key, Value] of Object.entries(Query)) Url.searchParams.set(Key, Value)
    if (Input instanceof Request) return BaseFetch(new Request(Url, Input))
    return BaseFetch(Url, Init)
  }
}
