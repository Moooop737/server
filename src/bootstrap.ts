/**
 * 启动装配 —— bootstrap() 读配置、组装 Deps（进程级入库管线工厂 + 检索工厂）、建空 app 并交出；startServer() 清理中断遗留、探一次向量维度、然后监听。
 * 缺必需 env → loadAppConfig() 打印错误并 process.exit(1)；cleanup 与维度体检失败都只记日志、不阻断启动。
 * config.chatModel 填了却不在 model 清单里 → assertChatModel 点名在册句柄并 exit(1)（env 指错行是人写错，与「缺 Key 静默缺席」两回事）；没填则不选，等消费它的 build 再收口。
 * Deps.ingestFactory / Deps.retrieverFactory 都是进程级单例工厂，路由各自在请求里 assemble(Recipe)；
 * Deps.inflight 是进程级取消登记处，工厂持有它、路由也用它（同一个实例，取消才按得到）。
 * Deps.repo 是基础层交出的服务，连接池对它来说是不可见的内部细节；本文件不再出现任何 SQL。
 * Deps.models 是 SDK 句柄，装配期只兑换一次（providerRegistry → modelRegistry），路由共享同一批实例；startServer 头一行把它打成 I_MODELS，登记制的静默缺席靠这行现形。
 * Deps.embedding 是装配层按 EMBEDDING_MODEL 从 model 清单里选定的那一行（句柄 + 标识 + 截维），入库与检索共用同一个；不在册 ⇒ E_EMBEDDING_MODEL 点名退出。
 * retrieverConfig 由 AppConfig 派生，供路由装 Recipe（策略名 + 活依赖 + 旋钮）；入库侧不吃旋钮 —— 三个 stage 都无构造参数。
 * Deps.vectorDimensions 是唯一的「启动后后填」字段，三态：buildDeps 先给 null，startServer 在 serve() 之前填成真值数组 ⇒ 路由不可能读到半填状态。
 * 体检失败就留在 null，检索会因此**拒绝作答**（E_DIMENSION_UNKNOWN）而不是退回 BM25-only 静默命中 —— 见 retrieve/retrievers.ts。
 * 依赖：config / adapter(contract) / ingest(recipes,inflight,ingest) / retrieve(recipes,retrievers)。
 */

import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { loadConfig, ConfigError } from "./config"
import { createRepo, modelRegistry, providerRegistry } from "./adapter/contract"
import { createStageRegistry } from "./ingest/recipes"
import { InflightRegistry } from "./ingest/inflight"
import { IngestFactory } from "./ingest/ingest"

export { bootstrap, startServer }
export type { Deps }

import type { AppConfig } from "./config"
import type { EmbeddingModelId, EmbeddingTarget, RegistedModels, Repo } from "./adapter/contract"
import type { RetrieverConfig } from "./retrieve/contracts";
import { RetrieverFactory } from "./retrieve/retrievers";
import { createRetrieverStageRegistry } from "./retrieve/recipes";

interface Deps {
  config: AppConfig
  repo: Repo
  models: RegistedModels
  embedding: EmbeddingTarget
  inflight: InflightRegistry
  ingestFactory: IngestFactory
  retrieverConfig: RetrieverConfig
  retrieverFactory: RetrieverFactory
  vectorDimensions: number[] | null
}

function bootstrap(): { app: Hono; deps: Deps } {
  const deps = buildDeps(loadAppConfig())
  assertChatModel(deps)
  return { app: new Hono(), deps }
}

function assertChatModel(AppDeps: Deps): void {
  const Name = AppDeps.config.chatModel
  if (Object.hasOwn(AppDeps.models.languageModels, Name)) return
  console.error(JSON.stringify({
    code: 'E_CHAT_MODEL',
    message: `CHAT_MODEL=${Name} 不在册；在册对话句柄=${Object.keys(AppDeps.models.languageModels).join(',') || '无'}`,
  }))
  process.exit(1)
}

function loadAppConfig(): AppConfig {
  try {
    return loadConfig()
  } catch (err) {
    const code = err instanceof ConfigError ? err.code : "E_CONFIG_UNKNOWN"
    const message = err instanceof ConfigError ? err.message : String(err)
    console.error(JSON.stringify({ code, message }))
    process.exit(1)
  }
}

function buildDeps(Config: AppConfig): Deps {
  const repo = createRepo(Config)
  const models = modelRegistry(providerRegistry())
  const embedding = pickEmbeddingTarget(models, Config)
  const inflight = new InflightRegistry()
  const ingestFactory = new IngestFactory(createStageRegistry(), inflight)
  const retrieverConfig: RetrieverConfig = {
    dimension: Config.embeddingDimensions,
    vectorTopK: Config.retrievalVectorTopK,
    lexicalTopK: Config.retrievalLexicalTopK,
    minSimilarity: Config.retrievalMinSimilarity,
    rrfK: Config.retrievalRrfK,
    defaultLimit: Config.retrievalDefaultLimit,
  }
  const retrieverFactory = new RetrieverFactory(createRetrieverStageRegistry())
  return {
    config: Config,
    repo,
    models,
    embedding,
    inflight,
    ingestFactory,
    retrieverConfig,
    retrieverFactory,
    vectorDimensions: null,
  }
}

// env 的宽 string 在这里唯一一次收窄成清单的键；不在册就是配置自相矛盾，启动点名而不是留到请求里冒成 500
function pickEmbeddingTarget(Models: RegistedModels, Config: AppConfig): EmbeddingTarget {
  const Name = Config.embeddingModel
  if (!Object.hasOwn(Models.embeddingModels, Name)) {
    console.error(JSON.stringify({
      code: 'E_EMBEDDING_MODEL',
      message: `EMBEDDING_MODEL=${Name} 不在册；在册嵌入句柄=${Object.keys(Models.embeddingModels).join(',') || '无'}`,
    }))
    process.exit(1)
  }
  return {
    model: Models.embeddingModels[Name as EmbeddingModelId]!,
    modelId: Name,
    dimensions: Config.embeddingDimensions,
  }
}

async function startServer(App: Hono, AppDeps: Deps): Promise<void> {
  console.log(JSON.stringify({
    code: 'I_MODELS',
    message: `对话句柄=${Object.keys(AppDeps.models.languageModels).join(',') || '无'} 嵌入句柄=${Object.keys(AppDeps.models.embeddingModels).join(',') || '无'}`,
  }))

  try {
    const cleaned = await AppDeps.repo.markInterruptedAsFailed()
    if (cleaned.resources > 0) {
      console.log(`启动清扫：${cleaned.resources} 条 processing 资源转为 failed(入库中断)`)
    }
  } catch (err) {
    console.error(JSON.stringify({ code: 'E_CLEANUP', message: String(err) }))
  }

  try {
    AppDeps.vectorDimensions = await AppDeps.repo.dimensionsInStore()
    console.log(JSON.stringify({
      code: 'I_VECTOR_DIMENSIONS',
      message: `库中向量维度=${AppDeps.vectorDimensions.join(',') || '空'} 检索维度=${AppDeps.retrieverConfig.dimension}`,
    }))
  } catch (err) {
    console.error(JSON.stringify({ code: 'E_DIMENSION_PROBE', message: String(err) }))
  }

  serve({
    fetch: App.fetch,
    hostname: AppDeps.config.host,
    port: AppDeps.config.port,
  })

  console.log('Server listening on http://' + AppDeps.config.host + ':' + AppDeps.config.port)
}
