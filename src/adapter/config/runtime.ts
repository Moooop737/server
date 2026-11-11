/**
 * 运行时配置快照 —— 从 DB 读 provider / model / default，解密 Key 与 headers，算出可用性与默认键。
 * 只产出纯数据，不造 SDK 客户端（AD-4：客户端归 provider/，句柄归 model/）。
 * 有密文但 CONFIG_SECRET_KEY 缺失 / 非法 → E_CONFIG_SECRET_KEY；单个 provider 解密失败只标 error，不中断整次装载。
 * 日志只打 name 与计数，不打印 Key / headers 值。
 */

export { RuntimeConfigLoader }
export type {
  RuntimeProvider, RuntimeModel, RuntimeConfig,
  ProviderKeyStatus, ProviderUnavailableReason, ModelUnavailableReason,
}

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { AppConfig } from '../../config'
import { PostgresConfigRepo } from '../repo/config'
import { ConfigSecretError, decryptSecret, parseSecretKey } from './secret'
import { logError, logInfo, logWarn } from '../../trace/systemtrace/log'

import type { EmbeddingModelV4, LanguageModelV4 } from '@ai-sdk/provider'
import type { ProviderKind, ModelKind, ProviderRow, ModelWithProvider } from '../contract'

type ProviderKeyStatus = 'none' | 'set' | 'error'

type ProviderUnavailableReason =
  | 'provider_disabled'
  | 'provider_no_key'
  | 'provider_key_error'
  | 'provider_headers_error'
  | null

type ModelUnavailableReason = Exclude<ProviderUnavailableReason, null> | 'model_disabled' | null

interface RuntimeProvider {
  id: string
  name: string
  kind: ProviderKind
  icon: string | null
  base_url: string | null
  api_key: string | null
  headers: Record<string, string>
  query: Record<string, string>
  options: Record<string, unknown>
  enabled: boolean
  key_status: ProviderKeyStatus
  headers_status: ProviderKeyStatus
  available: boolean
  unavailable_reason: ProviderUnavailableReason
}

interface RuntimeModel {
  key: string
  provider_id: string
  provider_name: string
  provider_kind: ProviderKind
  provider_icon: string | null
  model_id: string
  kind: ModelKind
  display_name: string
  dimensions: number | null
  enabled: boolean
  available: boolean
  unavailable_reason: ModelUnavailableReason
  isDefault: boolean
  model: LanguageModelV4 | EmbeddingModelV4 | null
}

interface RuntimeConfig {
  loaded_at: string
  providers: RuntimeProvider[]
  models: RuntimeModel[]
}

@singleton()
class RuntimeConfigLoader {
  private readonly repo: PostgresConfigRepo
  private readonly config: AppConfig

  constructor(
    @inject(PostgresConfigRepo) Repo: PostgresConfigRepo,
    @inject(AppConfig) Config: AppConfig,
  ) {
    this.repo = Repo
    this.config = Config
  }

  async load(): Promise<RuntimeConfig> {
    const Snapshot = await this.repo.readConfig()
    const HasCiphertext = Snapshot.providers.some(
      (Item) => Item.api_key_ciphertext !== null || Item.headers_ciphertext !== null,
    )
    const SecretKey = HasCiphertext ? parseSecretKey(this.config.configSecretKey) : null
    if (HasCiphertext && SecretKey === null) {
      throw new ConfigSecretError('E_CONFIG_SECRET_KEY', 'DB 中有密文，但 CONFIG_SECRET_KEY 缺失')
    }
    if (!HasCiphertext && this.config.configSecretKey === undefined) {
      logWarn('W_CONFIG_SECRET_KEY_EMPTY', 'CONFIG_SECRET_KEY 未设置；首次写入 Key / headers 前需补上')
    }
    if (Snapshot.providers.length === 0) {
      logWarn('W_CONFIG_EMPTY', '配置库为空：聊天 409 E_NO_CHAT_MODEL、入库 409 E_NO_EMBEDDING_MODEL')
    }

    const Providers = Snapshot.providers.map((Item) => runtimeProvider(Item, SecretKey))
    const ProviderById = new Map(Providers.map((Item) => [Item.id, Item]))
    const Models = Snapshot.models.map((Item) => {
      const Provider = ProviderById.get(Item.provider_id)
      if (Provider === undefined) throw new Error(`模型 ${Item.id} 指向不存在的 provider ${Item.provider_id}`)
      return runtimeModel(Item, Provider)
    })
    const ModelByKey = new Map(Models.map((Item) => [Item.key, Item]))

    const Orphans = Snapshot.defaults.filter((Row) => !ModelByKey.has(`${Row.provider_name}:${Row.model_id}`))
    for (const Row of Orphans) {
      try {
        await this.repo.deleteDefault(Row.id)
        logWarn('W_DEFAULT_ORPHAN_CLEANED', `默认行 ${Row.id} 的目标模型已不存在，已清理`)
      } catch (err) {
        logWarn('W_DEFAULT_ORPHAN_CLEANED', `默认行 ${Row.id} 清理失败：${String(err)}`)
      }
    }
    const DefaultRows = Snapshot.defaults.filter((Row) => !Orphans.includes(Row))
    const DefaultKeys = new Set<string>()
    for (const Row of DefaultRows) {
      const Slot = Row.id === 'default' ? 'language' : 'embedding'
      const Key = `${Row.provider_name}:${Row.model_id}`
      const Model = ModelByKey.get(Key)
      if (!Row.enabled || Model === undefined || !Model.available || Model.kind !== Slot) {
        logWarn('W_DEFAULT_MODEL_UNAVAILABLE', `默认行 ${Row.id} 的目标模型不可用: ${Key}`)
        continue
      }
      if (Slot === 'embedding' && Model.dimensions === null) {
        logWarn('W_DEFAULT_MODEL_UNAVAILABLE', `默认行 ${Row.id} 的嵌入模型缺少 dimensions: ${Key}`)
        continue
      }
      DefaultKeys.add(Key)
    }
    const ModelsWithDefaults = Models.map((Model) => (
      DefaultKeys.has(Model.key) ? { ...Model, isDefault: true } : Model
    ))

    logInfo(
      'I_RUNTIME_CONFIG',
      `providers=${Providers.filter((Item) => Item.available).length}/${Providers.length}`
      + ` models=${Models.filter((Item) => Item.available).length}/${Models.length}`
      + ` defaults=${[...DefaultKeys].join(',') || 'none'}`,
    )
    return { loaded_at: new Date().toISOString(), providers: Providers, models: ModelsWithDefaults }
  }
}

function runtimeProvider(Row: ProviderRow, SecretKey: Buffer | null): RuntimeProvider {
  if ((Row.api_key_ciphertext !== null || Row.headers_ciphertext !== null) && SecretKey === null) {
    throw new Error('编程错误：有密文却没有主密钥（load 前置条件被破坏）')
  }
  let ApiKey: string | null = null
  let KeyStatus: ProviderKeyStatus = 'none'
  if (Row.api_key_ciphertext !== null) {
    try {
      ApiKey = decryptSecret(Row.api_key_ciphertext, SecretKey!, Row.id)
      KeyStatus = 'set'
    } catch {
      KeyStatus = 'error'
      logError('E_PROVIDER_KEY_DECRYPT', `provider ${Row.name} 的 Key 解密失败`)
    }
  }

  let Headers: Record<string, string> = {}
  let HeadersStatus: ProviderKeyStatus = 'none'
  if (Row.headers_ciphertext !== null) {
    try {
      Headers = parseStringObject(decryptSecret(Row.headers_ciphertext, SecretKey!, `${Row.id}:headers`))
      HeadersStatus = 'set'
    } catch {
      HeadersStatus = 'error'
      logError('E_PROVIDER_HEADERS_DECRYPT', `provider ${Row.name} 的 headers 解密失败`)
    }
  }

  const NeedsKey = Row.kind === 'deepseek' || Row.kind === 'dashscope'
  if (NeedsKey && KeyStatus !== 'set') {
    logWarn('W_PROVIDER_NO_KEY', `provider ${Row.name} 未设置可用 Key，已跳过`)
  }
  const Available = Row.enabled
    && KeyStatus !== 'error'
    && HeadersStatus !== 'error'
    && (!NeedsKey || KeyStatus === 'set')
  const Reason: ProviderUnavailableReason = !Row.enabled
    ? 'provider_disabled'
    : KeyStatus === 'error'
      ? 'provider_key_error'
      : HeadersStatus === 'error'
        ? 'provider_headers_error'
        : NeedsKey && KeyStatus !== 'set'
          ? 'provider_no_key'
          : null

  return {
    id: Row.id,
    name: Row.name,
    kind: Row.kind,
    icon: Row.icon,
    base_url: Row.base_url,
    api_key: ApiKey,
    headers: Headers,
    query: Row.query,
    options: Row.options,
    enabled: Row.enabled,
    key_status: KeyStatus,
    headers_status: HeadersStatus,
    available: Available,
    unavailable_reason: Reason,
  }
}

function runtimeModel(Row: ModelWithProvider, Provider: RuntimeProvider): RuntimeModel {
  const Available = Row.enabled && Provider.available
  const Reason: ModelUnavailableReason = !Row.enabled
    ? 'model_disabled'
    : Provider.unavailable_reason
  return {
    key: Row.id,
    provider_id: Row.provider_id,
    provider_name: Row.provider_name,
    provider_kind: Row.provider_kind,
    provider_icon: Provider.icon,
    model_id: Row.model_id,
    kind: Row.kind,
    display_name: Row.display_name,
    dimensions: Row.dimensions,
    enabled: Row.enabled,
    available: Available,
    unavailable_reason: Available ? null : Reason,
    isDefault: false,
    model: null,
  }
}

function parseStringObject(Raw: string): Record<string, string> {
  const Value: unknown = JSON.parse(Raw)
  if (Value === null || typeof Value !== 'object' || Array.isArray(Value)) {
    throw new Error('headers 不是对象')
  }
  const Out: Record<string, string> = {}
  for (const [Key, Item] of Object.entries(Value)) {
    if (typeof Item !== 'string') throw new Error('headers 值不是字符串')
    Out[Key] = Item
  }
  return Out
}
