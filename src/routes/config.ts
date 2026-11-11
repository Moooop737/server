/**
 * /config —— 供应商 / 模型 / 默认模型的配置 API；裸 Hono，不进 hono-crud。
 * 写接口：DB 成功后 reload，返回 reload_ok；GET 从当前快照投影，不回明文 Key / headers。
 * /reload 串联模型与检索两个注册表；/status 汇总两者（retrieval 未装载时为 null）。
 * 本文件只做校验、错误映射与响应投影；加解密在 config/secret.ts，SQL 在 repo/config.ts。
 */

export { ConfigRoute }

import 'reflect-metadata'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { inject, injectable } from 'tsyringe'
import { AppConfig } from '../config'
import { PostgresConfigRepo, RuntimeRetrievalRegistry } from '../adapter/contract'
import { RuntimeModelRegistry } from '../adapter/model/runtime-registry'
import { ConfigSecretError, decryptSecret, encryptSecret, parseSecretKey } from '../adapter/config/secret'
import { discoverProvider, probeProvider, ProbeError } from '../adapter/provider/probe'
import { logError } from '../trace/systemtrace/log'

import type { CreateModelInput, DefaultRow, ModelWithProvider, ProviderKind, ProviderRow } from '../adapter/contract'
import type { RuntimeConfig, RuntimeModel, RuntimeProvider } from '../adapter/config/runtime'
import type { ProbeTarget } from '../adapter/provider/probe'

const KINDS: ProviderKind[] = ['deepseek', 'dashscope', 'openai-compatible', 'ollama']
const OPTION_KEYS: Record<ProviderKind, readonly string[]> = {
  deepseek: [],
  ollama: [],
  dashscope: ['includeUsage', 'videoBaseURL', 'embeddingBaseURL'],
  'openai-compatible': ['supportsStructuredOutputs', 'supportsMultiPartToolContent', 'includeUsage'],
}
const EMBEDDING_KINDS: ProviderKind[] = ['openai-compatible', 'dashscope']
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

@injectable()
class ConfigRoute {
  private readonly repo: PostgresConfigRepo
  private readonly runtime: RuntimeModelRegistry
  private readonly retrieval: RuntimeRetrievalRegistry
  private readonly config: AppConfig

  constructor(
    @inject(PostgresConfigRepo) Repo: PostgresConfigRepo,
    @inject(RuntimeModelRegistry) Runtime: RuntimeModelRegistry,
    @inject(RuntimeRetrievalRegistry) Retrieval: RuntimeRetrievalRegistry,
    @inject(AppConfig) Config: AppConfig,
  ) {
    this.repo = Repo
    this.runtime = Runtime
    this.retrieval = Retrieval
    this.config = Config
  }

  build(): Hono {
    const app = new Hono()
    const repo = this.repo
    const runtime = this.runtime
    const retrieval = this.retrieval
    const config = this.config

    app.get('/status', (c) => {
      try {
        return c.json({ ...runtime.status(), retrieval: retrievalStatus(retrieval) })
      } catch {
        return c.json({ code: 'E_CONFIG_NOT_LOADED', message: '运行时配置尚未装载' }, 503)
      }
    })

    app.post('/reload', async (c) => {
      const Models = await runtime.reload()
      const Retrieval = await retrieval.reload()
      const Ok = Models.ok && Retrieval.ok
      return c.json({
        reload_ok: Ok,
        ...(Ok ? {} : { reload_error: Models.error_code ?? Retrieval.error_code }),
        models: { reload_ok: Models.ok, ...(Models.error_code === null ? {} : { reload_error: Models.error_code }) },
        retrieval: { reload_ok: Retrieval.ok, ...(Retrieval.error_code === null ? {} : { reload_error: Retrieval.error_code }) },
      })
    })

    app.get('/providers', async (c) => {
      try {
        const Rows = await repo.listProviders()
        const Snap = currentConfig(runtime)
        const Models = Snap?.models ?? []
        const Providers = Snap?.providers ?? []
        return c.json({
          providers: Rows.map((Row) => providerView(
            Row,
            Providers.find((Item) => Item.id === Row.id),
            Models.filter((Item) => Item.provider_id === Row.id).length,
          )),
        })
      } catch (err) {
        logError('E_CONFIG_PROVIDER_LIST', String(err))
        return c.json({ code: 'E_CONFIG_PROVIDER_LIST', message: '读取供应商失败' }, 500)
      }
    })

    app.post('/providers', async (c) => {
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
      const Name = nonEmpty(Body.name)
      const Kind = parseKind(Body.kind)
      if (Name === null || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(Name)) {
        return bad(c, 'E_BAD_PROVIDER_NAME', 'name 需为小写字母/数字/-/_，1–32 字符')
      }
      if (Kind === null) return bad(c, 'E_BAD_PROVIDER_KIND', 'kind 不合法')
      const Base = parseBaseUrl(Kind, Body.base_url, true)
      if (!Base.ok) return bad(c, 'E_BAD_BASE_URL', Base.message)
      const Options = parseOptions(Kind, Body.options)
      if (!Options.ok) return bad(c, 'E_BAD_OPTIONS', Options.message)
      const Icon = parseIcon(Body.icon)
      if (!Icon.ok) return bad(c, 'E_BAD_ICON', Icon.message)

      try {
        const Row = await repo.createProvider({
          name: Name,
          kind: Kind,
          icon: Icon.value,
          base_url: Base.value ?? null,
          ...(Options.value === undefined ? {} : { options: Options.value }),
        })
        return await respond(c, runtime, () => ({
          provider: providerView(Row, runtimeProvider(runtime, Row.name), modelCount(runtime, Row.id)),
        }))
      } catch (err) {
        return mapUnique(c, err, 'E_PROVIDER_NAME_TAKEN', '供应商名称已存在', 'E_CONFIG_PROVIDER_CREATE', '新建供应商失败')
      }
    })

    app.patch('/providers/:id', async (c) => {
      const Id = c.req.param('id')
      if (!UUID.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
      const Row = await repo.getProvider(Id)
      if (Row === null) return notFound(c, '供应商不存在')
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')

      const Base = Object.hasOwn(Body, 'base_url') ? parseBaseUrl(Row.kind, Body.base_url, false) : null
      if (Base !== null && !Base.ok) return bad(c, 'E_BAD_BASE_URL', Base.message)
      let Enabled: boolean | undefined
      if (Object.hasOwn(Body, 'enabled')) {
        if (typeof Body.enabled !== 'boolean') return bad(c, 'E_BAD_ENABLED', 'enabled 需为 boolean')
        Enabled = Body.enabled
      }
      const Options = Object.hasOwn(Body, 'options') ? parseOptions(Row.kind, Body.options) : null
      if (Options !== null && !Options.ok) return bad(c, 'E_BAD_OPTIONS', Options.message)
      const Icon = Object.hasOwn(Body, 'icon') ? parseIcon(Body.icon) : null
      if (Icon !== null && !Icon.ok) return bad(c, 'E_BAD_ICON', Icon.message)
      if (Base === null && Enabled === undefined && Options === null && Icon === null) {
        return bad(c, 'E_BAD_BODY', '至少提供 base_url / enabled / options / icon 一项')
      }

      if (Base !== null && Base.value !== undefined && await repo.setProviderBaseUrl(Id, Base.value) === false) {
        return notFound(c, '供应商不存在')
      }
      if (Enabled !== undefined && await repo.setProviderEnabled(Id, Enabled) === false) return notFound(c, '供应商不存在')
      if (Options !== null && await repo.setProviderOptions(Id, Options.value ?? {}) === false) return notFound(c, '供应商不存在')
      if (Icon !== null && await repo.setProviderIcon(Id, Icon.value) === false) return notFound(c, '供应商不存在')

      const Updated = await repo.getProvider(Id)
      if (Updated === null) return notFound(c, '供应商不存在')
      return await respond(c, runtime, () => ({
        provider: providerView(Updated, runtimeProvider(runtime, Updated.name), modelCount(runtime, Updated.id)),
      }))
    })

    app.put('/providers/:id/api-key', async (c) => {
      const Id = c.req.param('id')
      if (!UUID.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
      const Row = await repo.getProvider(Id)
      if (Row === null) return notFound(c, '供应商不存在')
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
      const ApiKey = nonEmpty(Body.api_key)
      if (ApiKey === null || ApiKey.length > 4096) return bad(c, 'E_BAD_API_KEY', 'api_key 需为 1–4096 字符')

      const SecretKey = parseSecretKey(config.configSecretKey)
      if (SecretKey === null) return c.json({ code: 'E_CONFIG_SECRET_KEY', message: '未配置 CONFIG_SECRET_KEY' }, 500)
      let Ciphertext: string
      try {
        Ciphertext = encryptSecret(ApiKey, SecretKey, Row.id)
      } catch (err) {
        logError('E_CONFIG_SECRET', String(err))
        return c.json({ code: 'E_CONFIG_SECRET', message: 'Key 加密失败' }, 500)
      }
      if (await repo.setProviderApiKey(Id, Ciphertext) === false) return notFound(c, '供应商不存在')
      const Updated = await repo.getProvider(Id)
      if (Updated === null) return notFound(c, '供应商不存在')
      return await respond(c, runtime, () => ({
        provider: providerView(Updated, runtimeProvider(runtime, Updated.name), modelCount(runtime, Updated.id)),
      }))
    })

    app.delete('/providers/:id/api-key', async (c) => {
      const Id = c.req.param('id')
      if (!UUID.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
      if (await repo.getProvider(Id) === null) return notFound(c, '供应商不存在')
      if (await repo.setProviderApiKey(Id, null) === false) return notFound(c, '供应商不存在')
      const Updated = await repo.getProvider(Id)
      if (Updated === null) return notFound(c, '供应商不存在')
      return await respond(c, runtime, () => ({
        provider: providerView(Updated, runtimeProvider(runtime, Updated.name), modelCount(runtime, Updated.id)),
      }))
    })

    app.put('/providers/:id/headers', async (c) => {
      const Id = c.req.param('id')
      if (!UUID.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
      const Row = await repo.getProvider(Id)
      if (Row === null) return notFound(c, '供应商不存在')
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
      const Parsed = parseHeaders(Body.headers)
      if (!Parsed.ok) return bad(c, 'E_BAD_HEADERS', Parsed.message)

      let Ciphertext: string | null = null
      if (Parsed.value !== null) {
        const SecretKey = parseSecretKey(config.configSecretKey)
        if (SecretKey === null) return c.json({ code: 'E_CONFIG_SECRET_KEY', message: '未配置 CONFIG_SECRET_KEY' }, 500)
        try {
          Ciphertext = encryptSecret(JSON.stringify(Parsed.value), SecretKey, `${Row.id}:headers`)
        } catch (err) {
          logError('E_CONFIG_SECRET', String(err))
          return c.json({ code: 'E_CONFIG_SECRET', message: 'headers 加密失败' }, 500)
        }
      }
      if (await repo.setProviderHeaders(Id, Ciphertext) === false) return notFound(c, '供应商不存在')
      const Updated = await repo.getProvider(Id)
      if (Updated === null) return notFound(c, '供应商不存在')
      return await respond(c, runtime, () => ({
        provider: providerView(Updated, runtimeProvider(runtime, Updated.name), modelCount(runtime, Updated.id)),
      }))
    })

    app.put('/providers/:id/query', async (c) => {
      const Id = c.req.param('id')
      if (!UUID.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
      if (await repo.getProvider(Id) === null) return notFound(c, '供应商不存在')
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
      const Parsed = parseQuery(Body.query)
      if (!Parsed.ok) return bad(c, 'E_BAD_QUERY', Parsed.message)
      if (await repo.setProviderQuery(Id, Parsed.value) === false) return notFound(c, '供应商不存在')
      const Updated = await repo.getProvider(Id)
      if (Updated === null) return notFound(c, '供应商不存在')
      return await respond(c, runtime, () => ({
        provider: providerView(Updated, runtimeProvider(runtime, Updated.name), modelCount(runtime, Updated.id)),
      }))
    })

    app.delete('/providers/:id', async (c) => {
      const Id = c.req.param('id')
      if (!UUID.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
      if (await repo.deleteProvider(Id) === false) return notFound(c, '供应商不存在')
      return await respond(c, runtime, () => ({ deleted: true }))
    })

    app.post('/providers/test', async (c) => {
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
      const Draft = draftProbeTarget(Body)
      if (!Draft.ok) return bad(c, 'E_BAD_PROVIDER_TARGET', Draft.message)
      return c.json(await probeProvider(Draft.target))
    })

    app.post('/providers/:id/test', async (c) => {
      const Id = c.req.param('id')
      if (!UUID.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
      const Row = await repo.getProvider(Id)
      if (Row === null) return notFound(c, '供应商不存在')
      try {
        return c.json(await probeProvider(savedProbeTarget(Row, config)))
      } catch (err) {
        return probeError(c, err)
      }
    })

    app.post('/providers/:id/discover', async (c) => {
      const Id = c.req.param('id')
      if (!UUID.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
      const Row = await repo.getProvider(Id)
      if (Row === null) return notFound(c, '供应商不存在')
      try {
        const Result = await discoverProvider(savedProbeTarget(Row, config))
        const Existing = new Map<string, string>()
        for (const Model of await repo.listModels()) {
          if (Model.provider_id === Row.id) Existing.set(Model.model_id, Model.kind)
        }
        return c.json({
          ...Result,
          models: Result.models.map((Model) => ({
            ...Model,
            already_added: Existing.has(Model.model_id),
            already_kind: Existing.get(Model.model_id) ?? null,
          })),
        })
      } catch (err) {
        return probeError(c, err)
      }
    })

    app.post('/providers/:id/models/import', async (c) => {
      const Id = c.req.param('id')
      if (!UUID.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
      const Provider = await repo.getProvider(Id)
      if (Provider === null) return notFound(c, '供应商不存在')
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
      const RawModels = Body.models
      if (!Array.isArray(RawModels) || RawModels.length === 0) return bad(c, 'E_BAD_MODELS', 'models 需为非空数组')

      const Items: CreateModelInput[] = []
      const Seen = new Set<string>()
      const Skipped: Array<{ model_id: string; reason: 'exists' }> = []
      for (const Raw of RawModels) {
        if (Raw === null || typeof Raw !== 'object' || Array.isArray(Raw)) {
          return bad(c, 'E_BAD_MODELS', 'models 每项需为对象')
        }
        const Item = Raw as Record<string, unknown>
        const ModelId = nonEmpty(Item.model_id)
        const Kind = parseModelKind(Item.kind)
        const DisplayName = Item.display_name === undefined ? ModelId : nonEmpty(Item.display_name)
        if (ModelId === null) return bad(c, 'E_BAD_MODEL_ID', 'model_id 必填')
        if (Kind === null) return bad(c, 'E_BAD_MODEL_KIND', 'kind 需为 language 或 embedding')
        if (DisplayName === null || DisplayName.length > 80) return bad(c, 'E_BAD_DISPLAY_NAME', 'display_name 需为 1–80 字符')
        const Dimensions = parseDimensions(Kind, Item.dimensions)
        if (!Dimensions.ok) return bad(c, 'E_BAD_DIMENSIONS', Dimensions.message)
        if (Kind === 'embedding' && !EMBEDDING_KINDS.includes(Provider.kind)) {
          return c.json({ code: 'E_EMBEDDING_KIND_UNSUPPORTED', message: `kind=${Provider.kind} 的供应商不支持嵌入模型` }, 422)
        }
        if (Seen.has(ModelId)) {
          Skipped.push({ model_id: ModelId, reason: 'exists' })
          continue
        }
        Seen.add(ModelId)
        Items.push({
          id: `${Provider.name}:${ModelId}`,
          provider_id: Provider.id,
          model_id: ModelId,
          kind: Kind,
          display_name: DisplayName,
          dimensions: Dimensions.value,
        })
      }

      const Added: Array<{ id: string; model_id: string; kind: string }> = []
      for (const Item of Items) {
        try {
          const Model = await repo.createModel(Item)
          Added.push({ id: Model.id, model_id: Model.model_id, kind: Model.kind })
        } catch (err) {
          if (pgCode(err) === '23505') {
            Skipped.push({ model_id: Item.model_id, reason: 'exists' })
            continue
          }
          logError('E_CONFIG_MODEL_IMPORT', String(err))
          return c.json({ code: 'E_CONFIG_MODEL_IMPORT', message: '导入模型失败', added: Added }, 500)
        }
      }
      return await respond(c, runtime, () => ({ added: Added, skipped: Skipped }))
    })

    app.get('/models', async (c) => {
      try {
        const Rows = await repo.listModels()
        const Snap = currentConfig(runtime)
        return c.json({ models: Rows.map((Row) => modelRowView(Row, Snap)) })
      } catch {
        return c.json({ code: 'E_CONFIG_NOT_LOADED', message: '运行时配置尚未装载' }, 503)
      }
    })

    app.post('/models', async (c) => {
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
      const ProviderId = Body.provider_id
      const ModelId = nonEmpty(Body.model_id)
      const Kind = parseModelKind(Body.kind)
      const DisplayName = nonEmpty(Body.display_name)
      if (typeof ProviderId !== 'string' || !UUID.test(ProviderId)) return bad(c, 'E_BAD_PROVIDER_ID', 'provider_id 需为 UUID')
      if (ModelId === null) return bad(c, 'E_BAD_MODEL_ID', 'model_id 必填')
      if (Kind === null) return bad(c, 'E_BAD_MODEL_KIND', 'kind 需为 language 或 embedding')
      if (DisplayName === null || DisplayName.length > 80) return bad(c, 'E_BAD_DISPLAY_NAME', 'display_name 需为 1–80 字符')
      const Dimensions = parseDimensions(Kind, Body.dimensions)
      if (!Dimensions.ok) return bad(c, 'E_BAD_DIMENSIONS', Dimensions.message)
      const Provider = await repo.getProvider(ProviderId)
      if (Provider === null) return bad(c, 'E_BAD_PROVIDER_ID', 'provider 不存在')
      if (Kind === 'embedding' && !EMBEDDING_KINDS.includes(Provider.kind)) {
        return c.json({ code: 'E_EMBEDDING_KIND_UNSUPPORTED', message: `kind=${Provider.kind} 的供应商不支持嵌入模型` }, 422)
      }
      const Input: CreateModelInput = {
        id: `${Provider.name}:${ModelId}`,
        provider_id: Provider.id,
        model_id: ModelId,
        kind: Kind,
        display_name: DisplayName,
        dimensions: Dimensions.value,
      }
      try {
        const Model = await repo.createModel(Input)
        return await respond(c, runtime, () => ({ model: modelViewFromSnapshot(runtime, Model.id, Model) }))
      } catch (err) {
        return mapUnique(c, err, 'E_MODEL_TAKEN', '模型已存在', 'E_CONFIG_MODEL_CREATE', '新建模型失败')
      }
    })

    app.patch('/models/:id', async (c) => {
      const Id = c.req.param('id')
      const Existing = await repo.getModel(Id)
      if (Existing === null) return notFound(c, '模型不存在')
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
      const DisplayName = Object.hasOwn(Body, 'display_name') ? nonEmpty(Body.display_name) : Existing.display_name
      if (DisplayName === null || DisplayName.length > 80) return bad(c, 'E_BAD_DISPLAY_NAME', 'display_name 需为 1–80 字符')
      const Enabled = Object.hasOwn(Body, 'enabled') ? Body.enabled : Existing.enabled
      if (typeof Enabled !== 'boolean') return bad(c, 'E_BAD_ENABLED', 'enabled 需为 boolean')
      const Dimensions = Object.hasOwn(Body, 'dimensions')
        ? parseDimensions(Existing.kind, Body.dimensions)
        : { ok: true as const, value: Existing.dimensions }
      if (!Dimensions.ok) return bad(c, 'E_BAD_DIMENSIONS', Dimensions.message)
      const Updated = await repo.updateModel(Id, { display_name: DisplayName, dimensions: Dimensions.value, enabled: Enabled })
      if (Updated === null) return notFound(c, '模型不存在')
      return await respond(c, runtime, () => ({ model: modelViewFromSnapshot(runtime, Updated.id, Updated) }))
    })

    app.delete('/models/:id', async (c) => {
      const Id = c.req.param('id')
      if (await repo.deleteModel(Id) === false) return notFound(c, '模型不存在')
      return await respond(c, runtime, () => ({ deleted: true }))
    })

    app.get('/defaults', async (c) => {
      const Rows = await repo.listDefaults()
      const Snap = currentConfig(runtime)
      return c.json({ defaults: Rows.map((Row) => defaultView(Row, Snap)) })
    })

    app.put('/defaults/:id', async (c) => {
      const Id = c.req.param('id')
      if (Id !== 'default' && Id !== 'embedding') return bad(c, 'E_BAD_ID', 'id 需为 default 或 embedding')
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
      const ProviderName = nonEmpty(Body.provider)
      const ModelId = nonEmpty(Body.model_id)
      if (ProviderName === null || ModelId === null) return bad(c, 'E_BAD_BODY', 'provider 与 model_id 必填')
      const Provider = await repo.getProviderByName(ProviderName)
      if (Provider === null) return bad(c, 'E_DEFAULT_MODEL_NOT_FOUND', 'provider 不存在')
      const Model = await repo.getModel(`${Provider.name}:${ModelId}`)
      if (Model === null) return bad(c, 'E_DEFAULT_MODEL_NOT_FOUND', '模型不存在')
      const Expected = Id === 'default' ? 'language' : 'embedding'
      if (Model.kind !== Expected) return bad(c, 'E_DEFAULT_KIND_MISMATCH', `${Id} 需要 ${Expected} 模型`)
      const Saved = await repo.upsertDefault(Id, Provider.id, ModelId, Id === 'default' ? '默认对话模型' : '默认嵌入模型')
      return await respond(c, runtime, () => ({ default: defaultView(Saved, currentConfig(runtime)) }))
    })

    app.delete('/defaults/:id', async (c) => {
      const Id = c.req.param('id')
      if (Id !== 'default' && Id !== 'embedding') return bad(c, 'E_BAD_ID', 'id 需为 default 或 embedding')
      if (await repo.deleteDefault(Id) === false) return notFound(c, '默认行不存在')
      return await respond(c, runtime, () => ({ deleted: true }))
    })

    return app
  }
}

async function respond(c: Context, runtime: RuntimeModelRegistry, Build: () => unknown) {
  const Result = await runtime.reload()
  return c.json({
    ...(Build() as Record<string, unknown>),
    reload_ok: Result.ok,
    ...(Result.error_code === null ? {} : { reload_error: Result.error_code }),
  })
}

function retrievalStatus(registry: RuntimeRetrievalRegistry) {
  try {
    return registry.status()
  } catch {
    return null
  }
}

function currentConfig(runtime: RuntimeModelRegistry): RuntimeConfig | null {
  try {
    return runtime.current().config
  } catch {
    return null
  }
}

function runtimeProvider(runtime: RuntimeModelRegistry, Name: string): RuntimeProvider | undefined {
  return currentConfig(runtime)?.providers.find((Item) => Item.name === Name)
}

function modelCount(runtime: RuntimeModelRegistry, ProviderId: string): number {
  return currentConfig(runtime)?.models.filter((Item) => Item.provider_id === ProviderId).length ?? 0
}

function providerView(Row: ProviderRow, Runtime: RuntimeProvider | undefined, ModelCount: number) {
  return {
    id: Row.id,
    name: Row.name,
    kind: Row.kind,
    icon: Row.icon,
    base_url: Row.base_url,
    has_api_key: Row.api_key_ciphertext !== null,
    key_status: Runtime?.key_status ?? (Row.api_key_ciphertext === null ? 'none' : 'error'),
    has_headers: Row.headers_ciphertext !== null,
    header_names: Runtime === undefined ? [] : Object.keys(Runtime.headers),
    headers_status: Runtime?.headers_status ?? (Row.headers_ciphertext === null ? 'none' : 'error'),
    query: Row.query,
    options: Row.options,
    enabled: Row.enabled,
    available: Runtime?.available ?? false,
    unavailable_reason: Runtime?.unavailable_reason ?? null,
    model_count: ModelCount,
    created_at: Row.created_at,
    updated_at: Row.updated_at,
  }
}

function modelViewFromSnapshot(runtime: RuntimeModelRegistry, Key: string, Fallback: ModelWithProvider) {
  const Snap = currentConfig(runtime)?.models.find((Item) => Item.key === Key)
  return modelView(Snap ?? Fallback)
}

function modelRowView(Row: ModelWithProvider, Snap: RuntimeConfig | null) {
  const RuntimeModel = Snap?.models.find((Item) => Item.key === Row.id)
  return {
    ...modelView(Row),
    available: RuntimeModel?.available ?? false,
    unavailable_reason: RuntimeModel?.unavailable_reason ?? null,
  }
}

function modelView(Model: ModelWithProvider | RuntimeModel) {
  const Id = 'key' in Model ? Model.key : Model.id
  return {
    id: Id,
    provider_id: Model.provider_id,
    provider_name: Model.provider_name,
    provider_kind: Model.provider_kind,
    model_id: Model.model_id,
    kind: Model.kind,
    display_name: Model.display_name,
    dimensions: Model.dimensions,
    enabled: Model.enabled,
    available: 'available' in Model ? Model.available : false,
    unavailable_reason: 'unavailable_reason' in Model ? Model.unavailable_reason : null,
  }
}

function defaultView(Row: DefaultRow, Snap: RuntimeConfig | null) {
  const Key = `${Row.provider_name}:${Row.model_id}`
  const Kind = Row.id === 'default' ? 'language' : 'embedding'
  const Model = Snap?.models.find((Item) => Item.isDefault && Item.kind === Kind) ?? null
  return {
    id: Row.id,
    provider: Row.provider_name,
    model_id: Row.model_id,
    key: Key,
    kind: Kind,
    dimensions: Row.dimensions ?? Model?.dimensions ?? null,
    available: Model?.available ?? false,
    unavailable_reason: Model?.unavailable_reason ?? null,
    updated_at: Row.updated_at,
  }
}

function readObject(c: Context): Promise<Record<string, unknown> | null> {
  return c.req.json().catch(() => null).then((Body) => {
    if (Body === null || typeof Body !== 'object' || Array.isArray(Body)) return null
    return Body as Record<string, unknown>
  })
}

function nonEmpty(Value: unknown): string | null {
  if (typeof Value !== 'string') return null
  const Trimmed = Value.trim()
  return Trimmed === '' ? null : Trimmed
}

function parseKind(Value: unknown): ProviderKind | null {
  return typeof Value === 'string' && (KINDS as string[]).includes(Value) ? Value as ProviderKind : null
}

function parseModelKind(Value: unknown): 'language' | 'embedding' | null {
  return Value === 'language' || Value === 'embedding' ? Value : null
}

function parseIcon(Value: unknown) {
  if (Value === undefined || Value === null || Value === '') return { ok: true as const, value: null }
  if (typeof Value !== 'string') return { ok: false as const, message: 'icon 需为字符串' }
  const Trimmed = Value.trim()
  if (Trimmed === '' || [...Trimmed].length > 32 || /[\r\n]/.test(Trimmed)) {
    return { ok: false as const, message: 'icon 需为 1–32 字符' }
  }
  return { ok: true as const, value: Trimmed }
}

function isHttpUrl(Value: string): boolean {
  try {
    const Url = new URL(Value)
    return Url.protocol === 'http:' || Url.protocol === 'https:'
  } catch {
    return false
  }
}

function parseBaseUrl(Kind: ProviderKind, Value: unknown, Create: boolean) {
  if (Kind === 'deepseek' || Kind === 'dashscope') {
    if (Value === undefined || Value === null || Value === '') return { ok: true as const, value: null }
    return { ok: false as const, message: `${Kind} 的 base_url 必须为空` }
  }
  if (Value === undefined && Create) return { ok: false as const, message: `${Kind} 的 base_url 必填` }
  if (Value === undefined) return { ok: true as const, value: undefined }
  if (typeof Value !== 'string' || !isHttpUrl(Value)) {
    return { ok: false as const, message: 'base_url 必须是 http/https' }
  }
  const Parsed = new URL(Value)
  if (Parsed.username !== '' || Parsed.password !== '') {
    return { ok: false as const, message: 'base_url 不允许内嵌凭据' }
  }
  return { ok: true as const, value: Value }
}

function parseOptions(Kind: ProviderKind, Value: unknown) {
  if (Value === undefined) return { ok: true as const, value: undefined }
  if (Value === null || typeof Value !== 'object' || Array.isArray(Value)) {
    return { ok: false as const, message: 'options 需为对象' }
  }
  const Out: Record<string, unknown> = {}
  const Allowed = OPTION_KEYS[Kind]
  for (const [Key, Item] of Object.entries(Value)) {
    if (!Allowed.includes(Key)) return { ok: false as const, message: `${Kind} 不支持 option: ${Key}` }
    if (Key === 'videoBaseURL' || Key === 'embeddingBaseURL') {
      if (typeof Item !== 'string' || !isHttpUrl(Item)) return { ok: false as const, message: `${Key} 需为 http/https` }
    } else if (typeof Item !== 'boolean') {
      return { ok: false as const, message: `${Key} 需为 boolean` }
    }
    Out[Key] = Item
  }
  return { ok: true as const, value: Out }
}

function parseHeaders(Value: unknown) {
  if (Value === null || typeof Value !== 'object' || Array.isArray(Value)) {
    return { ok: false as const, message: 'headers 需为对象' }
  }
  const Entries = Object.entries(Value)
  if (Entries.length > 32) return { ok: false as const, message: 'headers 最多 32 个' }
  const Out: Record<string, string> = {}
  for (const [Key, Item] of Entries) {
    if (!HEADER_NAME.test(Key)) return { ok: false as const, message: `header 名不合法: ${Key}` }
    if (typeof Item !== 'string' || Item.length < 1 || Item.length > 1024 || /[\r\n]/.test(Item)) {
      return { ok: false as const, message: `header 值不合法: ${Key}` }
    }
    Out[Key] = Item
  }
  if (JSON.stringify(Out).length > 8192) return { ok: false as const, message: 'headers 总大小超限' }
  return { ok: true as const, value: Object.keys(Out).length === 0 ? null : Out }
}

function parseQuery(Value: unknown) {
  if (Value === null || typeof Value !== 'object' || Array.isArray(Value)) {
    return { ok: false as const, message: 'query 需为对象' }
  }
  const Entries = Object.entries(Value)
  if (Entries.length > 32) return { ok: false as const, message: 'query 最多 32 个' }
  const Out: Record<string, string> = {}
  for (const [Key, Item] of Entries) {
    if (typeof Key !== 'string' || Key.length < 1 || Key.length > 1024 || /[\r\n]/.test(Key)) {
      return { ok: false as const, message: 'query 键不合法' }
    }
    if (typeof Item !== 'string' || Item.length < 1 || Item.length > 1024 || /[\r\n]/.test(Item)) {
      return { ok: false as const, message: `query 值不合法: ${Key}` }
    }
    Out[Key] = Item
  }
  if (JSON.stringify(Out).length > 8192) return { ok: false as const, message: 'query 总大小超限' }
  return { ok: true as const, value: Out }
}

function parseDimensions(Kind: 'language' | 'embedding', Value: unknown) {
  if (Kind === 'language') {
    if (Value === undefined || Value === null) return { ok: true as const, value: null }
    return { ok: false as const, message: 'language 模型不接受 dimensions' }
  }
  if (typeof Value !== 'number' || !Number.isInteger(Value) || Value < 1 || Value > 16000) {
    return { ok: false as const, message: 'embedding dimensions 需为 1–16000 的整数' }
  }
  return { ok: true as const, value: Value }
}

function draftProbeTarget(Body: Record<string, unknown>):
  | { ok: true; target: ProbeTarget }
  | { ok: false; message: string } {
  const Kind = parseKind(Body.kind)
  if (Kind === null) return { ok: false, message: 'kind 不合法' }
  const Base = parseBaseUrl(Kind, Body.base_url, true)
  if (!Base.ok) return { ok: false, message: Base.message }

  const ApiKey = Body.api_key === undefined ? null : nonEmpty(Body.api_key)
  if (Body.api_key !== undefined && (ApiKey === null || ApiKey.length > 4096)) {
    return { ok: false, message: 'api_key 需为 1–4096 字符' }
  }

  const Headers: Record<string, string> = {}
  if (Body.headers !== undefined) {
    const Parsed = parseHeaders(Body.headers)
    if (!Parsed.ok) return { ok: false, message: Parsed.message }
    if (Parsed.value !== null) Object.assign(Headers, Parsed.value)
  }

  let Query: Record<string, string> = {}
  if (Body.query !== undefined) {
    const Parsed = parseQuery(Body.query)
    if (!Parsed.ok) return { ok: false, message: Parsed.message }
    Query = Parsed.value
  }

  return {
    ok: true,
    target: {
      kind: Kind,
      base_url: Base.value ?? null,
      api_key: ApiKey,
      headers: Headers,
      query: Query,
    },
  }
}

function savedProbeTarget(Row: ProviderRow, Config: AppConfig): ProbeTarget {
  let ApiKey: string | null = null
  if (Row.api_key_ciphertext !== null) {
    const SecretKey = parseSecretKey(Config.configSecretKey)
    if (SecretKey === null) throw new ConfigSecretError('E_CONFIG_SECRET_KEY', '未配置 CONFIG_SECRET_KEY')
    ApiKey = decryptSecret(Row.api_key_ciphertext, SecretKey, Row.id)
  }

  let Headers: Record<string, string> = {}
  if (Row.headers_ciphertext !== null) {
    const SecretKey = parseSecretKey(Config.configSecretKey)
    if (SecretKey === null) throw new ConfigSecretError('E_CONFIG_SECRET_KEY', '未配置 CONFIG_SECRET_KEY')
    Headers = parseStringObject(decryptSecret(Row.headers_ciphertext, SecretKey, `${Row.id}:headers`))
  }

  return {
    kind: Row.kind,
    base_url: Row.base_url,
    api_key: ApiKey,
    headers: Headers,
    query: Row.query,
  }
}

function parseStringObject(Raw: string): Record<string, string> {
  const Value: unknown = JSON.parse(Raw)
  if (Value === null || typeof Value !== 'object' || Array.isArray(Value)) {
    throw new ConfigSecretError('E_SECRET_DECRYPT', 'headers 不是对象')
  }
  const Out: Record<string, string> = {}
  for (const [Key, Item] of Object.entries(Value)) {
    if (typeof Item !== 'string') throw new ConfigSecretError('E_SECRET_DECRYPT', 'headers 值不是字符串')
    Out[Key] = Item
  }
  return Out
}

function probeError(c: Context, Err: unknown) {
  if (Err instanceof ProbeError) {
    return c.json({ code: Err.code, message: Err.message }, 502)
  }
  if (Err instanceof ConfigSecretError) {
    logError(Err.code, Err.message)
    return c.json({ code: Err.code, message: '配置密钥不可用' }, 500)
  }
  logError('E_PROVIDER_PROBE', String(Err))
  return c.json({ code: 'E_PROVIDER_PROBE', message: '探测失败' }, 500)
}

function bad(c: Context, Code: string, Message: string) {
  return c.json({ code: Code, message: Message }, 400)
}

function notFound(c: Context, Message: string) {
  return c.json({ code: 'E_NOT_FOUND', message: Message }, 404)
}

function mapUnique(c: Context, Err: unknown, UniqueCode: string, UniqueMessage: string, Fallback: string, Message: string) {
  if (pgCode(Err) === '23505') return c.json({ code: UniqueCode, message: UniqueMessage }, 409)
  logError(Fallback, String(Err))
  return c.json({ code: Fallback, message: Message }, 500)
}

function pgCode(Err: unknown): string | null {
  let Current: unknown = Err
  while (Current !== null && typeof Current === 'object') {
    const Code = (Current as { code?: unknown }).code
    if (typeof Code === 'string') return Code
    Current = (Current as { cause?: unknown }).cause
  }
  return null
}
