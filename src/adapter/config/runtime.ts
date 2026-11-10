/**
 * 运行时配置快照 —— 从 DB 读 provider / model / default，解密 Key 与 headers，算出可用性与默认键。
 * 只产出纯数据，不造 SDK 客户端（AD-4：客户端归 provider/，句柄归 model/）。
 * 有密文但 CONFIG_SECRET_KEY 缺失 / 非法 → E_CONFIG_SECRET_KEY；单个 provider 解密失败只标 error，不中断整次装载。
 * 日志只打 name 与计数，不打印 Key / headers 值。
 */

export { RuntimeConfigLoader }
export type {
  RuntimeProvider, RuntimeModel, RuntimeDefaults, RuntimeConfig,
  ProviderKeyStatus, ProviderUnavailableReason, ModelUnavailableReason,
}

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { AppConfig } from '../../config'
import { PostgresConfigRepo } from '../repo/config'
import { ConfigSecretError, decryptSecret, parseSecretKey } from './secret'
import { logError, logInfo, logWarn } from '../../trace/systemtrace/log'

import type { ProviderKind, ModelKind, ProviderRow, ModelWithProvider, DefaultRow } from '../contract'

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
  model_id: string
  kind: ModelKind
  display_name: string
  dimensions: number | null
  enabled: boolean
  available: boolean
  unavailable_reason: ModelUnavailableReason
}

interface RuntimeDefaults {
  language: string | null
  embedding: string | null
}

interface RuntimeConfig {
  loaded_at: string
  providers: RuntimeProvider[]
  models: RuntimeModel[]
  defaults: RuntimeDefaults
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
    const SecretKey = parseSecretKey(this.config.configSecretKey)
    const HasCiphertext = Snapshot.providers.some(
      (Item) => Item.api_key_ciphertext !== null || Item.headers_ciphertext !== null,
    )
    if (HasCiphertext && SecretKey === null) {
      throw new ConfigSecretError('E_CONFIG_SECRET_KEY', 'DB 中有密文，但 CONFIG_SECRET_KEY 缺失')
    }

    const Providers = Snapshot.providers.map((Item) => runtimeProvider(Item, SecretKey))
    const ProviderById = new Map(Providers.map((Item) => [Item.id, Item]))
    const Models = Snapshot.models.map((Item) => runtimeModel(Item, ProviderById.get(Item.provider_id)))
    const ModelByKey = new Map(Models.map((Item) => [Item.key, Item]))
    const Defaults = runtimeDefaults(Snapshot.defaults, ModelByKey)

    logInfo(
      'I_RUNTIME_CONFIG',
      `providers=${Providers.filter((Item) => Item.available).length}/${Providers.length}`
      + ` models=${Models.filter((Item) => Item.available).length}/${Models.length}`
      + ` default=${Defaults.language ?? 'null'} embedding=${Defaults.embedding ?? 'null'}`,
    )
    return { loaded_at: new Date().toISOString(), providers: Providers, models: Models, defaults: Defaults }
  }
}

function runtimeProvider(Row: ProviderRow, SecretKey: Buffer | null): RuntimeProvider {
  let ApiKey: string | null = null
  let KeyStatus: ProviderKeyStatus = 'none'
  if (Row.api_key_ciphertext !== null) {
    if (SecretKey === null) {
      KeyStatus = 'error'
    } else {
      try {
        ApiKey = decryptSecret(Row.api_key_ciphertext, SecretKey, Row.id)
        KeyStatus = 'set'
      } catch {
        KeyStatus = 'error'
        logError('E_PROVIDER_KEY_DECRYPT', `provider ${Row.name} 的 Key 解密失败`)
      }
    }
  }

  let Headers: Record<string, string> = {}
  let HeadersStatus: ProviderKeyStatus = 'none'
  if (Row.headers_ciphertext !== null) {
    if (SecretKey === null) {
      HeadersStatus = 'error'
    } else {
      try {
        Headers = parseStringObject(
          decryptSecret(Row.headers_ciphertext, SecretKey, `${Row.id}:headers`),
        )
        HeadersStatus = 'set'
      } catch {
        HeadersStatus = 'error'
        logError('E_PROVIDER_HEADERS_DECRYPT', `provider ${Row.name} 的 headers 解密失败`)
      }
    }
  }

  const NeedsKey = Row.kind === 'deepseek' || Row.kind === 'dashscope'
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

function runtimeModel(Row: ModelWithProvider, Provider: RuntimeProvider | undefined): RuntimeModel {
  const Available = Row.enabled && Provider?.available === true
  const Reason: ModelUnavailableReason = !Row.enabled
    ? 'model_disabled'
    : Provider === undefined
      ? 'provider_disabled'
      : Provider.unavailable_reason
  return {
    key: Row.id,
    provider_id: Row.provider_id,
    provider_name: Row.provider_name,
    provider_kind: Row.provider_kind,
    model_id: Row.model_id,
    kind: Row.kind,
    display_name: Row.display_name,
    dimensions: Row.dimensions,
    enabled: Row.enabled,
    available: Available,
    unavailable_reason: Available ? null : Reason,
  }
}

function runtimeDefaults(Rows: DefaultRow[], ModelByKey: Map<string, RuntimeModel>): RuntimeDefaults {
  const Out: RuntimeDefaults = { language: null, embedding: null }
  for (const Row of Rows) {
    const Slot = Row.id === 'default' ? 'language' : 'embedding'
    const Key = `${Row.provider_name}:${Row.model_id}`
    const Model = ModelByKey.get(Key)
    if (!Row.enabled || Model === undefined || !Model.available || Model.kind !== Slot) {
      logWarn('W_DEFAULT_MODEL_UNAVAILABLE', `默认行 ${Row.id} 的目标模型不可用: ${Key}`)
      continue
    }
    Out[Slot] = Key
  }
  return Out
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
