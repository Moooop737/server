/**
 * llmtrace 桥 —— 业务模块只认这个无第三方依赖的接口；真正的 Langfuse/OTel 实现只在 src/index.ts 启动时注入。
 * 这样测试/脚本 import ChatService 不会顺手加载 @opentelemetry/*，也不会注册 exporter。
 */

export { getLlmtraceBridge, setLlmtraceBridge, CHAT_FUNCTION_ID }
export type { LlmtraceBridge, ChatTraceParams }

import type { StageSink } from '../systemtrace/stage'

const CHAT_FUNCTION_ID = 'chat'

interface ChatTraceParams {
  sessionId: string
  localTraceId?: string
}

interface LlmtraceBridge {
  beginChat(Params: ChatTraceParams): void
  takeChatTraceId(LocalTraceId: string): string | undefined
  createStageSink(): StageSink | null
}

let bridge: LlmtraceBridge | null = null

function setLlmtraceBridge(Bridge: LlmtraceBridge | null): void {
  bridge = Bridge
}

function getLlmtraceBridge(): LlmtraceBridge | null {
  return bridge
}
