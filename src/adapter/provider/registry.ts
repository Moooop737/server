import { type ProviderV4 } from "@ai-sdk/provider"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { createAlibaba } from "@ai-sdk/alibaba"
import { createOllama } from "ai-sdk-ollama"
import { getEnv } from "../../config";
import { type RegistedProviders } from "../contract"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export { providerRegistry, type ProviderEntryName }

type ProviderEntry =
    | { needsKey: true; name: string; apiKey: string | undefined; create: (ApiKey: string) => ProviderV4 }
    | { needsKey: false; name: string; create: () => ProviderV4 }

type ProviderEntryName = typeof ProviderList[number]['name']

const ProviderList = [
    {
        needsKey: true,
        name: 'deepseek', apiKey: getEnv('DEEPSEEK_API_KEY'), create: (ApiKey) => createDeepSeek({ apiKey: ApiKey })
    },
    {
        needsKey: true,
        name: 'dashscope', apiKey: getEnv('DASHSCOPE_API_KEY'), create: (ApiKey) => createAlibaba({ apiKey: ApiKey })
    },
    {
        needsKey: false,
        name: 'ollama', create: () => createOllama({ baseURL: getEnv('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434' })
    },
    {
        needsKey: false,
        name: 'ollama-compat',
        create: () => createOpenAICompatible({
            name: 'ollama-compat',
            baseURL: `${(getEnv('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')}/v1`
        })
    },
    {
        needsKey: true,
        name: 'silicon-flow',
        apiKey: getEnv('SILICONFLOW_API_KEY'),
        create: (ApiKey) => createOpenAICompatible({
            name: 'silicon-flow',
            apiKey: ApiKey,
            baseURL: 'https://api.siliconflow.cn/v1',
            supportsStructuredOutputs:true
        })
    },
    {
        needsKey: true,
        name: 'router1',
        apiKey: getEnv('ROUTER1_API_KEY'),
        create: (ApiKey) => createOpenAICompatible({
            name: 'router1',
            apiKey: ApiKey,
            baseURL: getEnv('ROUTER1_END_POINT')!,
            supportsStructuredOutputs:true
        })
    }

] as const satisfies ProviderEntry[]

const providerRegistry = (): RegistedProviders => {
    const providers: RegistedProviders = {}
    for (const entry of ProviderList) {
        if (entry.needsKey) {
            if (entry.apiKey === undefined) continue
            providers[entry.name] = entry.create(entry.apiKey)
        } else {
            providers[entry.name] = entry.create()
        }
    }
    return providers
}
