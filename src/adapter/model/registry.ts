/**
 * model/registry —— 把 adapter/provider 那张在册表里的服务商兑换成 SDK 模型句柄（AD-4：全系统唯一兑换位）。
 * 只兑换、不发起调用：本文件交句柄，同格的 `embed-chunks.ts` 才是 `embedMany` 的调用封装（AD-4 两格分放）；`streamText` 留 `agent/`。
 * 兑换完当场打一条 I_MODELS：登记制的规矩是「缺 Key 就整行静默缺席」，这行清单是让那件事唯一可见的地方，所以它住在这里而不是住在启动序列里。
 * 清单的键是 `${provider}:${modelId}`：同一个 modelId 挂在两家服务商上是两行，互不覆盖（modelId 自己带 `/`，所以分隔符用 `:`）。
 * name 只给人看，不参与任何查找；env 的 CHAT_MODEL / EMBEDDING_MODEL 写的是键，选择发生在装配层，不在这里。
 * provider 不在册（缺 Key 没进表）⇒ 它的行一起静默缺席，和 provider 表同一条登记制规则。
 * 维度不在这里定死：EmbeddingModelV4 句柄没有 dimensions 位，它是调用选项，由调用侧传。
 * 同一家 Ollama 挂两个网关是故意的：嵌入那行走 ollama-compat（/v1），因为原生 /api/embed 实测把 dimensions 整位丢掉、恒回 4096（test/probe-native-embed.ts），MRL 截维只在兼容层生效；
 * 对话那几行留原生，才拿得到 think / num_ctx 这类原生参数。
 * 表里全是字面量，本文件不读 env。
 */

import 'reflect-metadata'
import { singleton } from 'tsyringe'
import { providerRegistry } from '../provider/registry'
import { type AlibabaChatModelId } from '@ai-sdk/alibaba'
import { type DeepSeekProvider } from '@ai-sdk/deepseek'
import { type EmbeddingModelV4, type LanguageModelV4 } from '@ai-sdk/provider'
import { type RegistedModels } from '../contract'
import { logInfo } from '../../trace/systemtrace/log'

export { ModelRegistry, type LanguageModelId, type EmbeddingModelId }

type DeepSeekChatModelId = Parameters<DeepSeekProvider['languageModel']>[0]

type ModelEntry =
    | { kind: 'languageModel'; provider: 'deepseek'; modelId: DeepSeekChatModelId; name: string }
    | { kind: 'languageModel'; provider: 'dashscope'; modelId: AlibabaChatModelId; name: string }
    | { kind: 'languageModel'; provider: 'ollama'; modelId: string; name: string }
    | { kind: 'embeddingModel'; provider: 'ollama-compat'; modelId: string; name: string }
    | { kind: 'languageModel'; provider: string; modelId: string; name: string }

type ModelRow = typeof ModelList[number]
type LanguageModelRow = Extract<ModelRow, { kind: 'languageModel' }>
type EmbeddingModelRow = Extract<ModelRow, { kind: 'embeddingModel' }>
type LanguageModelId = `${LanguageModelRow['provider']}:${LanguageModelRow['modelId']}`
type EmbeddingModelId = `${EmbeddingModelRow['provider']}:${EmbeddingModelRow['modelId']}`

const ModelList = [
    { kind: 'languageModel', provider: 'deepseek', modelId: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { kind: 'languageModel', provider: 'deepseek', modelId: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { kind: 'languageModel', provider: 'dashscope', modelId: 'qwen-plus', name: 'Qwen Plus' },
    { kind: 'languageModel', provider: 'ollama', modelId: 'qwen3.8-27b', name: 'Qwen3.8 27B' },
    { kind: 'languageModel', provider: 'ollama', modelId: 'qwen3.8-27b-32k', name: 'Qwen3.8 27B 32K' },
    { kind: 'languageModel', provider: 'ollama', modelId: 'qwen3.8GGUF-iq4', name: 'Qwen3.8 27B GGUF iq4' },
    { kind: 'embeddingModel', provider: 'ollama-compat', modelId: 'qwenembed', name: 'Qwen Embed' },
    { kind: 'languageModel', provider: 'router1', modelId: 'deepseek-flash', name: 'DeepSeek Flash' },
    { kind: 'languageModel', provider: 'silicon-flow', modelId: 'THUDM/GLM-4-9B-0414', name: 'GLM4 9B' },
    { kind: 'languageModel', provider: 'silicon-flow', modelId: 'Qwen/Qwen3-8B', name: 'Qwen3 8B' }
] as const satisfies ModelEntry[]

@singleton()
class ModelRegistry implements RegistedModels {
    readonly languageModels: Partial<Record<LanguageModelId, LanguageModelV4>> = {}
    readonly languageProviders: Partial<Record<LanguageModelId, string>> = {}
    readonly languageNames: Partial<Record<LanguageModelId, string>> = {}
    readonly embeddingModels: Partial<Record<EmbeddingModelId, EmbeddingModelV4>> = {}

    constructor() {
        const Providers = providerRegistry()
        for (const entry of ModelList) {
            const provider = Providers[entry.provider]
            if (provider === undefined) continue

            if (entry.kind === 'embeddingModel') {
                const Key = `${entry.provider}:${entry.modelId}` as EmbeddingModelId
                this.embeddingModels[Key] = provider.embeddingModel(entry.modelId)
            } else {
                const Key = `${entry.provider}:${entry.modelId}` as LanguageModelId
                this.languageModels[Key] = provider.languageModel(entry.modelId)
                this.languageProviders[Key] = entry.provider
                this.languageNames[Key] = entry.name
            }
        }

        logInfo('I_MODELS', `对话句柄=${Object.keys(this.languageModels).join(',') || '无'} 嵌入句柄=${Object.keys(this.embeddingModels).join(',') || '无'}`)
    }
}
