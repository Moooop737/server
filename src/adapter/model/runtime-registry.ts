/**
 * 运行时模型注册表 —— 持有当前配置快照、provider 客户端、语言/嵌入句柄。
 * load() 用于启动；reload() 用于配置写入后的热更新，串行队列 + 原子替换。
 * reload 失败保留旧快照并返回 error_code；成功与否以 last_reload 为准。
 * 本文件不读 DB / env：数据来自 RuntimeConfigLoader，客户端来自 provider/factory。
 */

export { RuntimeModelRegistry, RuntimeRegistryError }
export type { RuntimeSnapshot, RuntimeReloadResult, RuntimeStatus, EmbeddingDefault }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { RuntimeConfigLoader } from '../config/runtime'
import { buildProviderHandles } from '../provider/factory'
import { logError, logInfo } from '../../trace/systemtrace/log'

import type { EmbeddingModelV4, LanguageModelV4, ProviderV4 } from '@ai-sdk/provider'
import type { RuntimeConfig } from '../config/runtime'

interface RuntimeSnapshot {
  loaded_at: string
  config: RuntimeConfig
  providers: Map<string, ProviderV4>
  languageModels: Map<string, LanguageModelV4>
  embeddingModels: Map<string, EmbeddingModelV4>
}

interface RuntimeReloadResult {
  ok: boolean
  error_code: string | null
}

interface EmbeddingDefault {
  key: string
  model: EmbeddingModelV4
  modelId: string
  dimensions: number
}

interface RuntimeStatus {
  loaded_at: string
  provider_count: number
  model_count: number
  default_chat_available: boolean
  default_embedding_available: boolean
  last_reload: { ok: boolean; at: string; error_code: string | null } | null
}

class RuntimeRegistryError extends Error {
  readonly code: string

  constructor(Code: string, Message: string) {
    super(Message)
    this.name = 'RuntimeRegistryError'
    this.code = Code
  }
}

@singleton()
class RuntimeModelRegistry {
  private snapshot: RuntimeSnapshot | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private lastReload: RuntimeStatus['last_reload'] = null
  private readonly loader: RuntimeConfigLoader

  constructor(@inject(RuntimeConfigLoader) Loader: RuntimeConfigLoader) {
    this.loader = Loader
  }

  async load(): Promise<RuntimeSnapshot> {
    return this.enqueue(async () => {
      const Next = await this.build()
      this.snapshot = Next
      return Next
    })
  }

  async reload(): Promise<RuntimeReloadResult> {
    return this.enqueue(async () => {
      try {
        const Next = await this.build()
        this.snapshot = Next
        this.lastReload = { ok: true, at: new Date().toISOString(), error_code: null }
        logInfo('I_CONFIG_RELOAD', '热更新成功')
        return { ok: true, error_code: null }
      } catch (Err) {
        const Code = errorCode(Err)
        this.lastReload = { ok: false, at: new Date().toISOString(), error_code: Code }
        logError('E_CONFIG_RELOAD', `热更新失败，继续用旧快照：${Code}`)
        return { ok: false, error_code: Code }
      }
    })
  }

  current(): RuntimeSnapshot {
    if (this.snapshot === null) {
      throw new RuntimeRegistryError('E_CONFIG_NOT_LOADED', '运行时配置尚未装载')
    }
    return this.snapshot
  }

  resolve(Key: string): LanguageModelV4 | undefined {
    return this.current().languageModels.get(Key)
  }

  catalog(): { id: string; provider: string; provider_kind: string; name: string }[] {
    return this.current().config.models
      .filter((Item) => Item.kind === 'language' && Item.available)
      .map((Item) => ({
        id: Item.key,
        provider: Item.provider_name,
        provider_kind: Item.provider_kind,
        name: Item.display_name,
      }))
  }

  defaultKey(): string | null {
    return this.current().config.defaults.language
  }

  status(): RuntimeStatus {
    const Snap = this.current()
    return {
      loaded_at: Snap.loaded_at,
      provider_count: Snap.config.providers.length,
      model_count: Snap.config.models.length,
      default_chat_available: Snap.config.defaults.language !== null,
      default_embedding_available: Snap.config.defaults.embedding !== null,
      last_reload: this.lastReload,
    }
  }

  embeddingDefault(): EmbeddingDefault | null {
    const Snap = this.current()
    const Key = Snap.config.defaults.embedding
    if (Key === null) return null
    const Model = Snap.config.models.find((Item) => Item.key === Key)
    const Handle = Snap.embeddingModels.get(Key)
    if (Model === undefined || Handle === undefined) return null
    if (Model.dimensions === null) return null
    return { key: Key, model: Handle, modelId: Model.model_id, dimensions: Model.dimensions }
  }

  private async build(): Promise<RuntimeSnapshot> {
    const Config = await this.loader.load()
    const Providers = buildProviderHandles(Config.providers)
    const LanguageModels = new Map<string, LanguageModelV4>()
    const EmbeddingModels = new Map<string, EmbeddingModelV4>()

    for (const Model of Config.models) {
      if (!Model.available) continue
      const Provider = Providers.get(Model.provider_name)
      if (Provider === undefined) continue
      if (Model.kind === 'embedding') {
        EmbeddingModels.set(Model.key, Provider.embeddingModel(Model.model_id))
      } else {
        LanguageModels.set(Model.key, Provider.languageModel(Model.model_id))
      }
    }

    logInfo(
      'I_RUNTIME_REGISTRY',
      `providers=${Providers.size}`
      + ` language=${LanguageModels.size} embedding=${EmbeddingModels.size}`
      + ` default=${Config.defaults.language ?? 'null'} embedDefault=${Config.defaults.embedding ?? 'null'}`,
    )
    return {
      loaded_at: Config.loaded_at,
      config: Config,
      providers: Providers,
      languageModels: LanguageModels,
      embeddingModels: EmbeddingModels,
    }
  }

  private enqueue<T>(Fn: () => Promise<T>): Promise<T> {
    const Run = this.queue.then(Fn, Fn)
    this.queue = Run.then(() => undefined, () => undefined)
    return Run
  }
}

function errorCode(Err: unknown): string {
  let Current: unknown = Err
  while (Current !== null && typeof Current === 'object') {
    const Code = (Current as { code?: unknown }).code
    if (typeof Code === 'string') return Code
    Current = (Current as { cause?: unknown }).cause
  }
  return 'E_CONFIG_RELOAD'
}
