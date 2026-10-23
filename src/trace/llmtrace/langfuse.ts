/**
 * chat 侧 Langfuse 装配 —— 只由 src/index.ts 启动时调一次 setupLangfuse()；业务模块只认 bridge.ts，不会 import 本文件。
 * 三件套缺失时只打一行 I_TRACE_EXPORT_DISABLED：AI SDK telemetry 不注册 integration，本地 traces 公共行照写。
 * AI SDK 的根 span 不设全局 active，且要到流消费时才创建；ChatSpanProcessor 在根 span onStart 时用 ALS 的本地 trace_id
 *   查 beginChat 存下的 sessionId，把 session.id / traceName / tags / metadata 直接写到根 span，并交出 trace id。
 * 不打印 Key；导出失败只影响 Langfuse，不影响 /chat。
 */

export { setupLangfuse }

import { trace } from '@opentelemetry/api'
import { TracerProvider } from '@opentelemetry/sdk-trace'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { LangfuseVercelAiSdkIntegration } from '@langfuse/vercel-ai-sdk'
import { LangfuseOtelSpanAttributes } from '@langfuse/tracing'
import { registerTelemetry } from 'ai'
import { currentTraceId, logInfo } from '../systemtrace/log'
import { CHAT_FUNCTION_ID, setLlmtraceBridge } from './bridge'

import type { Span } from '@opentelemetry/api'
import type { SpanProcessor } from '@opentelemetry/sdk-trace'
import type { ChatTraceParams } from './bridge'

interface SdkSpan extends Span {
  readonly parentSpanContext?: { spanId: string }
  readonly attributes: Record<string, unknown>
}

const Chats = new Map<string, string>()
const TraceIds = new Map<string, string>()

let started = false

function setupLangfuse(): void {
  if (started) return
  started = true
  if (!configured()) {
    logInfo('I_TRACE_EXPORT_DISABLED', 'Langfuse 三件套未配置，chat trace 只写本地公共行')
    return
  }
  const processor = new LangfuseSpanProcessor()
  const provider = new TracerProvider({ spanProcessors: [processor, new ChatSpanProcessor()] })
  trace.setGlobalTracerProvider(provider)
  registerTelemetry(new LangfuseVercelAiSdkIntegration())
  setLlmtraceBridge({ beginChat, takeChatTraceId })
}

function beginChat(Params: ChatTraceParams): void {
  if (Params.localTraceId === undefined) return
  Chats.set(Params.localTraceId, Params.sessionId)
}

function takeChatTraceId(LocalTraceId: string): string | undefined {
  const TraceId = TraceIds.get(LocalTraceId)
  if (TraceId !== undefined) {
    TraceIds.delete(LocalTraceId)
    Chats.delete(LocalTraceId)
  }
  return TraceId
}

class ChatSpanProcessor implements SpanProcessor {
  onStart(Span: Span): void {
    const Sdk = Span as SdkSpan
    if (Sdk.parentSpanContext) return
    if (Sdk.attributes['gen_ai.agent.name'] !== CHAT_FUNCTION_ID) return
    const LocalTraceId = currentTraceId()
    if (LocalTraceId === undefined) return
    const SessionId = Chats.get(LocalTraceId)
    if (SessionId === undefined) return
    Span.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, SessionId)
    Span.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, 'chat')
    Span.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, ['chat'])
    Span.setAttribute(`${LangfuseOtelSpanAttributes.TRACE_METADATA}.route`, 'POST /chat')
    Span.setAttribute(`${LangfuseOtelSpanAttributes.TRACE_METADATA}.local_trace_id`, LocalTraceId)
    TraceIds.set(LocalTraceId, Span.spanContext().traceId)
  }

  onEnd(): void {}

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }
}

function configured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim() &&
    process.env.LANGFUSE_BASE_URL?.trim(),
  )
}
