/**
 * 答案执行 —— 与 /chat 同一套 INSTRUCTIONS 与 retrieve 工具，但用 generateText 非流式、不读不写会话历史。
 * 评测跑在独立调用里：不落 sessions/messages，也没有 chat 的 trace 绑定；调用方只拿回答与扁平化后的引用。
 * 引用按工具结果出现顺序编号（1..N），与回答里的 [n] 对应；多次 retrieve 的结果依次往后排。
 */

export { answerCase }
export type { AnswerOutcome }

import { generateText, stepCountIs } from 'ai'
import { INSTRUCTIONS } from '../agent/prompt/instruction'
import { buildAgentTools } from '../agent/tool/registry'

import type { LanguageModelV4 } from '@ai-sdk/provider'
import type { EvalCitation } from '../adapter/contract'
import type { RetrievedHit } from '../agent/tool/contracts'
import type { Retriever } from '../retrieve/contracts'

interface AnswerOutcome {
  answer: string
  citations: EvalCitation[]
  error: string | null
}

async function answerCase(Model: LanguageModelV4, Retriever: Retriever, Query: string): Promise<AnswerOutcome> {
  try {
    const Result = await generateText({
      model: Model,
      instructions: INSTRUCTIONS,
      messages: [{ role: 'user', content: Query }],
      tools: buildAgentTools(Retriever),
      stopWhen: stepCountIs(5),
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
