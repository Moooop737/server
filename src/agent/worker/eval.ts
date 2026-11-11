/**
 * 评测 worker —— 与 ChatWorker 共用 Chat 核心，但不读不写会话、不接 trace；
 * 只把一条 query 跑成回答与扁平化引用。工具用评测世界那份 retriever/repo 建，Chat 不碰检索。
 */

export { EvalWorker }
export type { AnswerOutcome, AnswerOptions }

import { Chat } from '../chat/chat'
import { weaveAgentTools } from '../tool/weave'
import { retrieve } from '../tool/tools/retrieve'
import { resource } from '../tool/tools/resource'
import { GLOBAL_INSTRUCTIONS } from '../prompt/instruction'

import type { LanguageModelV4 } from '@ai-sdk/provider'
import type { EvalCitation, Repo } from '../../adapter/contract'
import type { Retriever } from '../../retrieve/contracts'
import type { RetrievedHit } from '../tool/contracts'

const STEP_LIMIT = 5

interface AnswerOptions {
  temperature?: number
}

interface AnswerOutcome {
  answer: string
  citations: EvalCitation[]
  error: string | null
}

class EvalWorker {
  private readonly retriever: Retriever
  private readonly repo: Repo
  private readonly chat = new Chat()

  constructor(Retriever: Retriever, Repo: Repo) {
    this.retriever = Retriever
    this.repo = Repo
  }

  async answer(Model: LanguageModelV4, Query: string, Options: AnswerOptions = {}): Promise<AnswerOutcome> {
    try {
      const { instructions, tools } = weaveAgentTools([
        retrieve(this.retriever, { trace: false }),
        resource(this.repo),
      ], GLOBAL_INSTRUCTIONS)
      const Result = await this.chat.generate([{ role: 'user', content: Query }], {
        model: Model,
        instructions,
        tools,
        stepLimit: STEP_LIMIT,
        abortSignal: AbortSignal.timeout(120_000),
        ...(Options.temperature === undefined ? {} : { temperature: Options.temperature }),
      })

      const Citations: EvalCitation[] = []
      for (const Step of Result.steps) {
        for (const Item of Step.toolResults) {
          if (Item.toolName !== 'retrieve') continue
          const Hits = (Item.output as { hits?: RetrievedHit[] } | undefined)?.hits
          if (!Array.isArray(Hits)) continue
          for (const Hit of Hits) {
            Citations.push({
              index: Citations.length + 1,
              chunkId: Hit.chunkId,
              dataUri: Hit.dataUri,
              chunkIndex: Hit.chunkIndex,
              docTitle: Hit.docTitle,
              source: Hit.source ?? null,
              content: Hit.content,
            })
          }
        }
      }
      return { answer: Result.text, citations: Citations, error: null }
    } catch (Err) {
      return { answer: '', citations: [], error: Err instanceof Error ? Err.message : String(Err) }
    }
  }
}
