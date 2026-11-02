/**
 * 回合核心 —— 只做 SDK 调用：模型、instructions、tools、stepLimit 全部由调用方按次传入。
 * 不持有 retriever / repo：它们属于工具，worker 用自己那份建好工具再交进来；没有工具时这里完全用不到。
 * 实例由 worker 各自 new：ChatWorker 与 EvalWorker 各一只，不做共享单例。
 */

export { Chat }
export type { ChatCallOptions, ChatStreamOptions }

import {
  generateText,
  stepCountIs,
  streamText,
  type GenerateTextResult,
  type ModelMessage,
  type StreamTextResult,
  type TelemetryOptions,
  type ToolSet,
} from 'ai'

import type { LanguageModelV4 } from '@ai-sdk/provider'

interface ChatCallOptions<TOOLS extends ToolSet> {
  model: LanguageModelV4
  instructions: string
  tools: TOOLS
  stepLimit: number
  abortSignal?: AbortSignal
  telemetry?: TelemetryOptions
  temperature?: number
}

interface ChatStreamOptions<TOOLS extends ToolSet> extends ChatCallOptions<TOOLS> {
  onError?: (Event: { error: unknown }) => void
}

class Chat {
  stream<TOOLS extends ToolSet>(Messages: ModelMessage[], Options: ChatStreamOptions<TOOLS>): StreamTextResult<TOOLS, any, any> {
    return streamText({
      model: Options.model,
      messages: Messages,
      instructions: Options.instructions,
      tools: Options.tools,
      stopWhen: stepCountIs(Options.stepLimit),
      ...(Options.abortSignal === undefined ? {} : { abortSignal: Options.abortSignal }),
      ...(Options.telemetry === undefined ? {} : { telemetry: Options.telemetry }),
      ...(Options.temperature === undefined ? {} : { temperature: Options.temperature }),
      ...(Options.onError === undefined ? {} : { onError: Options.onError }),
    })
  }

  generate<TOOLS extends ToolSet>(Messages: ModelMessage[], Options: ChatCallOptions<TOOLS>): Promise<GenerateTextResult<TOOLS, any, any>> {
    return generateText({
      model: Options.model,
      messages: Messages,
      instructions: Options.instructions,
      tools: Options.tools,
      stopWhen: stepCountIs(Options.stepLimit),
      ...(Options.abortSignal === undefined ? {} : { abortSignal: Options.abortSignal }),
      ...(Options.telemetry === undefined ? {} : { telemetry: Options.telemetry }),
      ...(Options.temperature === undefined ? {} : { temperature: Options.temperature }),
    })
  }
}
