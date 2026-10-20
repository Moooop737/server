/**
 * model/registry —— 把 adapter/provider 那张在册表里的服务商兑换成 SDK 模型句柄（AD-4：全系统唯一兑换位）。
 * 只兑换、不发起调用：本文件交句柄，同格的 `embed-chunks.ts` 才是 `embedMany` 的调用封装（AD-4 两格分放）；`streamText` 留 `agent/`。
 * 兑换完当场打一条 I_MODELS：登记制的规矩是「缺 Key 就整行静默缺席」，这行清单是让那件事唯一可见的地方，所以它住在这里而不是住在启动序列里。
 * 清单的键就是真 modelId（不自造 name），两个 Record 都以它为键；
 * env 的 CHAT_MODEL / EMBEDDING_MODEL 是「今天用的是哪一行」的选择位，选择发生在装配层，不在这里。
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
import { type OllamaProvider } from 'ai-sdk-ollama'
import { type EmbeddingModelV4, type LanguageModelV4 } from '@ai-sdk/provider'
import { type RegistedModels } from '../contract'

export { ModelRegistry, type LanguageModelId, type EmbeddingModelId }

type DeepSeekChatModelId = Parameters<DeepSeekProvider['languageModel']>[0]

type ModelEntry =
    | { kind: 'languageModel'; provider: 'deepseek'; modelId: DeepSeekChatModelId }
    | { kind: 'languageModel'; provider: 'dashscope'; modelId: AlibabaChatModelId }
    | { kind: 'languageModel'; provider: 'ollama'; modelId: string }
    | { kind: 'embeddingModel'; provider: 'ollama-compat'; modelId: string }

type ModelRow = typeof ModelList[number]
type LanguageModelId = Extract<ModelRow, { kind: 'languageModel' }>['modelId']
type EmbeddingModelId = Extract<ModelRow, { kind: 'embeddingModel' }>['modelId']

const ModelList = [
    { kind: 'languageModel', provider: 'deepseek', modelId: 'deepseek-v4-flash' },
    { kind: 'languageModel', provider: 'deepseek', modelId: 'deepseek-v4-pro' },
    { kind: 'languageModel', provider: 'dashscope', modelId: 'qwen-plus' },
    { kind: 'languageModel', provider: 'ollama', modelId: 'qwen3.8-27b' },
    { kind: 'languageModel', provider: 'ollama', modelId: 'qwen3.8-27b-32k' },
    { kind: 'embeddingModel', provider: 'ollama-compat', modelId: 'qwenembed' },
] as const satisfies ModelEntry[]

@singleton()
class ModelRegistry implements RegistedModels {
    readonly languageModels: Partial<Record<LanguageModelId, LanguageModelV4>> = {}
    readonly embeddingModels: Partial<Record<EmbeddingModelId, EmbeddingModelV4>> = {}

    constructor() {
        const Providers = providerRegistry()
        for (const entry of ModelList) {
            const provider = Providers[entry.provider]
            if (provider === undefined) continue

            if (entry.kind === 'embeddingModel') {
                this.embeddingModels[entry.modelId] = provider.embeddingModel(entry.modelId)
            } else {
                this.languageModels[entry.modelId] = provider.languageModel(entry.modelId)
            }
        }

        console.log(JSON.stringify({
            code: 'I_MODELS',
            message: `对话句柄=${Object.keys(this.languageModels).join(',') || '无'} 嵌入句柄=${Object.keys(this.embeddingModels).join(',') || '无'}`,
        }))
    }
}