/**
 * 运行时模型注册表 —— 持有当前配置快照、provider 客户端、语言/嵌入句柄。
 * load() 用于启动；reload() 用于配置写入后的热更新，串行队列 + 原子替换。
 * reload 失败保留旧快照并返回 error_code；成功与否以 last_reload 为准。
 * 本文件不读 DB / env：数据来自 RuntimeConfigLoader，客户端来自 provider/factory。
 */

export { RuntimeModelRegistry, RuntimeRegistryError }
export type { RuntimeSnapshot, RuntimeReloadResult, RuntimeStatus }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { RuntimeConfigLoader } from '../config/runtime'
import { buildProviderHandles } from '../provider/factory'
import { logError, logInfo, logWarn } from '../../trace/systemtrace/log'

import type { LanguageModelV4, ProviderV4 } from '@ai-sdk/provider'
import type { RuntimeConfig, RuntimeModel } from '../config/runtime'

interface RuntimeSnapshot {
  generation: number
  loaded_at: string
  config: RuntimeConfig
  providers: Map<string, ProviderV4>
}

interface RuntimeReloadResult {
  ok: boolean
  error_code: string | null
}

interface RuntimeStatus {
  generation: number
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
  private generation = 0
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
    const Model = this.current().config.models.find((Item) => Item.key === Key && Item.kind === 'language')
    return (Model?.model as LanguageModelV4 | null) ?? undefined
  }

  catalog(): { id: string; provider: string; provider_kind: string; icon: string | null; name: string }[] {
    return this.current().config.models
      .filter((Item) => Item.kind === 'language' && Item.available)
      .map((Item) => ({
        id: Item.key,
        provider: Item.provider_name,
        provider_kind: Item.provider_kind,
        icon: Item.provider_icon,
        name: Item.display_name,
      }))
  }

  defaultKey(): string | null {
    return this.current().config.models.find((Item) => Item.isDefault && Item.kind === 'language')?.key ?? null
  }

  defaultModel(): LanguageModelV4 | null {
    const Model = this.current().config.models.find((Item) => Item.isDefault && Item.kind === 'language')
    return (Model?.model as LanguageModelV4 | null) ?? null
  }

  status(): RuntimeStatus {
    const Snap = this.current()
    return {
      generation: Snap.generation,
      loaded_at: Snap.loaded_at,
      provider_count: Snap.config.providers.length,
      model_count: Snap.config.models.length,
      default_chat_available: Snap.config.models.some((Item) => Item.isDefault && Item.kind === 'language'),
      default_embedding_available: Snap.config.models.some((Item) => Item.isDefault && Item.kind === 'embedding'),
      last_reload: this.lastReload,
    }
  }

  embeddingDefault(): RuntimeModel | null {
    return this.current().config.models.find((Item) => Item.isDefault && Item.kind === 'embedding') ?? null
  }

  requireEmbeddingDefault(): RuntimeModel {
    const Default = this.embeddingDefault()
    if (Default === null) {
      throw new RuntimeRegistryError('E_NO_EMBEDDING_MODEL', '未配置可用的默认嵌入模型')
    }
    return Default
  }

  private async build(): Promise<RuntimeSnapshot> {
    const Config = await this.loader.load()
    const Providers = buildProviderHandles(Config.providers)
    const Models = Config.models.map((Model) => {
      if (!Model.available) return Model
      const Provider = Providers.get(Model.provider_name)
      if (Provider === undefined) return Model
      try {
        const Handle = Model.kind === 'embedding'
          ? Provider.embeddingModel(Model.model_id)
          : Provider.languageModel(Model.model_id)
        return { ...Model, model: Handle }
      } catch (Err) {
        /* 供应商不支持该模型类型（如 deepseek 没有 embeddingModel）时跳过，不让一行坏配置拖垮整次装载 */
        logWarn('W_MODEL_SKIP', `模型 ${Model.key} 造句柄失败，已跳过：${Err instanceof Error ? Err.message : String(Err)}`)
        return Model
      }
    })
    const FinalModels = Models.map((Model) => (
      Model.isDefault && Model.model === null ? { ...Model, isDefault: false } : Model
    ))
    const Defaults = FinalModels.filter((Model) => Model.isDefault)

    logInfo(
      'I_RUNTIME_REGISTRY',
      `providers=${Providers.size}`
      + ` models=${FinalModels.filter((Model) => Model.model !== null).length}`
      + ` default=${Defaults.map((Model) => `${Model.kind}=${Model.key}`).join(',') || 'none'}`,
    )
    return {
      generation: ++this.generation,
      loaded_at: Config.loaded_at,
      config: { ...Config, models: FinalModels },
      providers: Providers,
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
