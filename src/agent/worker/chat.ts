/**
 * 生产 worker —— /chat 的会话生命周期都在这里：读历史、落 user、建工具、跑 Chat、收 UI 流、落 assistant、写 trace。
 * 工具用主库那份 retriever/repo 建；Chat 不碰检索，只拿到建好的工具。
 */

export { ChatWorker }

import { createUIMessageStreamResponse, toUIMessageStream } from 'ai'
import { ChatHandle, PostgresRepo, RetrieverHandle } from '../../adapter/contract'
import { RuntimeRegistryError } from '../../adapter/model/runtime-registry'
import { inject, singleton } from 'tsyringe'
import { Chat } from '../chat/chat'
import { weaveAgentTools } from '../tool/weave'
import { retrieve } from '../tool/tools/retrieve'
import { resource } from '../tool/tools/resource'
import { GLOBAL_INSTRUCTIONS } from '../prompt/instruction'
import { CHAT_FUNCTION_ID, getLlmtraceBridge } from '../../trace/llmtrace/bridge'
import { currentTraceId, logError, runWithTrace } from '../../trace/systemtrace/log'
import { SessionHistory } from '../prompt/history'
import { assistantContent, classifyChatError, resolveTurnFailure, resolveTurnStatus, type ChatFailure } from '../chat/outcome'

import type { LanguageModelV4 } from '@ai-sdk/provider'
import type { Repo } from '../../adapter/contract'
import type { Retriever } from '../../retrieve/contracts'

const HISTORY_MESSAGES = 12
const STEP_LIMIT = 5

@singleton()
class ChatWorker {
  private readonly repo: Repo
  private readonly history: SessionHistory
  private readonly handle: ChatHandle
  private readonly retriever: Retriever
  private readonly chat = new Chat()

  constructor(
    @inject(ChatHandle) Handle: ChatHandle,
    @inject(RetrieverHandle) R: RetrieverHandle,
    @inject(PostgresRepo) Repo: Repo,
    @inject(SessionHistory) History: SessionHistory) {
    this.repo = Repo
    this.history = History
    this.handle = Handle
    this.retriever = R.retriever
  }

  async ask(Query: string, SessionId: string, Signal: AbortSignal, Model?: LanguageModelV4): Promise<Response> {
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
      const { uiMessages, modelMessages } = await this.history.loadSessionContext(Query, SessionId, HISTORY_MESSAGES, TraceId)
      let Failure: ChatFailure | null = null
      const Chosen = Model ?? this.handle.defaultModel()
      if (Chosen === null) {
        throw new RuntimeRegistryError('E_NO_CHAT_MODEL', '未配置可用的默认对话模型')
      }
      const { instructions, tools } = weaveAgentTools([
        retrieve(this.retriever),
        resource(this.repo),
      ], GLOBAL_INSTRUCTIONS)
      const Result = this.chat.stream(modelMessages, {
        model: Chosen,
        instructions,
        tools,
        stepLimit: STEP_LIMIT,
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
        tools,
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
              trace_id: TraceId ?? null,
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
