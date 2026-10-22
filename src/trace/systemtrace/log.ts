/**
 * 请求内日志 —— pino 输出单行 JSON，形如 { level, time, trace_id?, code, message, ...extra }。
 * trace_id 由 AsyncLocalStorage 提供：endpoint.ts 在整段请求外包 runWithTrace；pino 的 mixin 每次写日志时取号，
 *   不在请求作用域（启动、后台任务、流式回调）时该字段省略，不伪造。
 * 三个 logX 只决定 level；code 用稳定的 E_/W_/I_ 标识，message 写人话。
 * chat 的流式回调在请求作用域之外执行：先用 currentTraceId 取号，再用 runWithTrace 把回调包回同一 trace（3.2 接）。
 */

export { runWithTrace, currentTraceId, logInfo, logWarn, logError }

import { AsyncLocalStorage } from 'node:async_hooks'
import { pino } from 'pino'

interface TraceScope {
  traceId: string
}

const scope = new AsyncLocalStorage<TraceScope>()

const logger = pino({
  base: null,
  messageKey: 'message',
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (Label) => ({ level: Label }) },
  mixin() {
    const TraceId = scope.getStore()?.traceId
    return TraceId === undefined ? {} : { trace_id: TraceId }
  },
})

function runWithTrace<T>(TraceId: string, Fn: () => T): T {
  return scope.run({ traceId: TraceId }, Fn)
}

function currentTraceId(): string | undefined {
  return scope.getStore()?.traceId
}

function logInfo(Code: string, Message: string, Extra?: Record<string, unknown>): void {
  logger.info({ code: Code, ...Extra }, Message)
}

function logWarn(Code: string, Message: string, Extra?: Record<string, unknown>): void {
  logger.warn({ code: Code, ...Extra }, Message)
}

function logError(Code: string, Message: string, Extra?: Record<string, unknown>): void {
  logger.error({ code: Code, ...Extra }, Message)
}
