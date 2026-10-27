/**
 * 聊天回合的纯判定：状态、错误分类、assistant 正文。
 *
 * 失败只用 SDK 的 isInstance 分类；ChatFailure.message 只进日志，客户端只收固定文案。
 * statusCode / retryable 留给排障与后续降级链。
 */

export { assistantContent, classifyChatError, resolveTurnFailure, resolveTurnStatus }
export type { ChatErrorCode, ChatFailure }

import { APICallError, JSONParseError, RetryError, TypeValidationError } from 'ai'
import type { UIMessage, UIMessageStreamOutcome } from 'ai'

type TurnStatus = 'ok' | 'error' | 'cancelled'

type ChatErrorCode = 'E_CHAT_PROVIDER' | 'E_CHAT_PARSE' | 'E_CHAT_STREAM'

interface ChatFailure {
  code: ChatErrorCode
  message: string
  statusCode?: number
  retryable: boolean
}

interface TurnStatusInput {
  isAborted: boolean | undefined
  isCancelled: boolean | undefined
  outcome: UIMessageStreamOutcome
  failure: ChatFailure | null
}

function resolveTurnStatus({ isAborted, isCancelled, outcome, failure }: TurnStatusInput): TurnStatus {
  if (isAborted || isCancelled || outcome.status === 'aborted') return 'cancelled'
  if (outcome.status === 'completed' && failure === null) return 'ok'
  return 'error'
}

function resolveTurnFailure(Failure: ChatFailure | null, Outcome: UIMessageStreamOutcome): ChatFailure | null {
  if (Failure !== null) return Failure
  if (Outcome.status === 'failed' && Outcome.error !== undefined) return classifyChatError(Outcome.error)
  return null
}

function classifyChatError(Err: unknown): ChatFailure {
  const Message = Err instanceof Error ? Err.message : String(Err)
  if (APICallError.isInstance(Err)) {
    return {
      code: 'E_CHAT_PROVIDER',
      message: Message,
      ...(Err.statusCode === undefined ? {} : { statusCode: Err.statusCode }),
      retryable: Err.isRetryable,
    }
  }
  if (RetryError.isInstance(Err)) {
    return { code: 'E_CHAT_PROVIDER', message: Message, retryable: Err.reason === 'maxRetriesExceeded' }
  }
  if (JSONParseError.isInstance(Err) || TypeValidationError.isInstance(Err)) {
    return { code: 'E_CHAT_PARSE', message: Message, retryable: false }
  }
  return { code: 'E_CHAT_STREAM', message: Message, retryable: false }
}

function assistantContent(Parts: UIMessage['parts']): string {
  return Parts.map((Part) => (Part.type === 'text' ? Part.text : '')).join('')
}
