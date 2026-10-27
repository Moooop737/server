export { ChatService }

import { createUIMessageStreamResponse, stepCountIs, streamText, toUIMessageStream, type ToolSet, type UIMessage } from 'ai'
import { ChatHandle, PostgresRepo, RetrieverHandle } from '../../adapter/contract'
import { inject, singleton } from 'tsyringe';
import { buildAgentTools } from '../tool/registry';
import { CHAT_FUNCTION_ID, getLlmtraceBridge } from '../../trace/llmtrace/bridge'
import { currentTraceId, logError, runWithTrace } from '../../trace/systemtrace/log'
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { Repo } from '../../adapter/contract'
import { INSTRUCTIONS } from '../prompt/instruction';
import { SessionHistory } from '../prompt/history';
import { assistantContent, classifyChatError, resolveTurnFailure, resolveTurnStatus, type ChatFailure } from './outcome';

const HISTORY_MESSAGES = 12

@singleton()
class ChatService {
  private readonly tools: ToolSet
  private readonly model: LanguageModelV4
  private readonly repo: Repo
  private readonly history: SessionHistory

  constructor(
    @inject(ChatHandle) Handle: ChatHandle,
    @inject(RetrieverHandle) R: RetrieverHandle,
    @inject(PostgresRepo) Repo: Repo,
    @inject(SessionHistory) History: SessionHistory) {
    this.model = Handle.model
    this.tools = buildAgentTools(R.retriever)
    this.repo = Repo
    this.history = History
  }

  async ask(Query: string, SessionId: string, Signal: AbortSignal): Promise<Response> {
    const TraceId = currentTraceId()
    const StartedMs = Date.now()
    const withTrace = <T>(Fn: () => T): T => TraceId === undefined ? Fn() : runWithTrace(TraceId, Fn)
    const Bridge = getLlmtraceBridge()
    if (TraceId !== undefined) {
      Bridge?.beginChat({ sessionId: SessionId, localTraceId: TraceId })
    }

    if (TraceId !== undefined) {
      try {
        await this.repo.setTraceSession(TraceId, SessionId)
      } catch (err) {
        logError('E_TRACE_WRITE', `更新 trace session 失败: ${String(err)}`)
      }
    }

    try {
      const { uiMessages, modelMessages } = await this.history.loadSessionContext(Query, SessionId, HISTORY_MESSAGES)
      let Failure: ChatFailure | null = null

      const Result = streamText({
        model: this.model,
        messages: modelMessages,
        instructions: INSTRUCTIONS,
        tools: this.tools,
        stopWhen: stepCountIs(5),
        abortSignal: Signal,
        telemetry: { functionId: CHAT_FUNCTION_ID },
        onError: ({ error }) => {
          const Classified = classifyChatError(error)
          Failure = Classified
          withTrace(() => logError(Classified.code, `${Classified.message} status=${Classified.statusCode ?? '-'} retryable=${Classified.retryable}`))
        },
      })

      const Stream = toUIMessageStream({
        stream: Result.stream,
        tools: this.tools,
        originalMessages: uiMessages,
        onError: () => '问答失败',
        /* 中断/取消不落 assistant：半截回答只在界面上标「未完整」，库里留的是一条孤立 user 消息。 */
        onEnd: (Event) => withTrace(async () => {
          const { responseMessage, isAborted, isCancelled, outcome } = Event
          const TurnFailure = resolveTurnFailure(Failure, outcome)
          const Status = resolveTurnStatus({ isAborted, isCancelled, outcome, failure: TurnFailure })
          const ErrorCode = Status === 'error' ? TurnFailure?.code ?? 'E_CHAT_STREAM' : null
          const LangfuseTraceId = TraceId === undefined ? undefined : Bridge?.takeChatTraceId(TraceId)

          if (TraceId !== undefined) {
            try {
              await this.repo.finishTrace(TraceId, {
                ended_at: new Date().toISOString(),
                duration_ms: Date.now() - StartedMs,
                http_status: 200,
                status: Status,
                error_code: ErrorCode,
                payloads: null,
                session_id: SessionId,
                ...(LangfuseTraceId === undefined ? {} : { langfuse_trace_id: LangfuseTraceId }),
              })
            } catch (err) {
              logError('E_TRACE_WRITE', `流式收口 trace 失败: ${String(err)}`)
            }
          }

          if (isAborted || isCancelled) return
          const Parts = responseMessage.parts
          const Content = assistantContent(Parts)
          try {
            await this.repo.createMessage({
              session_id: SessionId,
              role: 'assistant',
              content: Content,
              parts: Parts,
            })
          } catch (err) {
            logError('E_MESSAGE_SAVE', String(err))
          }
        }),
      })

      return createUIMessageStreamResponse({ stream: Stream })
    } catch (err) {
      // 建流前失败不会有 onEnd：把 beginChat 的登记在这里取走，否则 Chats 永久残留
      if (TraceId !== undefined) Bridge?.takeChatTraceId(TraceId)
      throw err
    }
  }
}
