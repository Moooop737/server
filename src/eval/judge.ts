/**
 * judge —— 用 rubric 文本 + 问题 + 回答 + 检索片段，让模型按结构化输出给三维分与 case 级 verdict。
 * 没有默认模型（OQ-7.4-2）：调用方传句柄，null 表示不跑；不强制与被评模型不同源。
 * rubric 存版本名（OQ-7.4-3）：正文住在版本表，建 run 时由 snapshot 冻结实际文本。
 * 失败不抛：回 error 让该 case 继续，run 不因 judge 单条失败而中断。
 */

export { resolveRubric, judgeCase, verdictOfScores, RUBRIC_V1 }
export type { Rubric }

import { generateText, Output } from 'ai'
import { z } from 'zod'

import type { LanguageModelV4 } from '@ai-sdk/provider'
import type { EvalCitation, EvalJudgeResult } from '../adapter/contract'

interface Rubric {
  version: string
  text: string
}

const RUBRIC_V1 = `你是知识库问答的评分员。只根据「检索片段」判断回答，不要使用片段以外的知识。
三个维度各打 0/1/2 分：
- groundedness（有据）：0 = 有明显编造；1 = 部分有据、部分无据；2 = 全部陈述都能在片段找到依据。
- correctness（正确）：0 = 答错或答偏；1 = 部分正确；2 = 正确且完整回答问题。
- citation（引用）：回答必须用命中片段的前 8 位 chunkId 在方括号里标注，片段也以相同的 8 位 id 标注。0 = 没有引用或引用的 id 不在片段里；1 = 部分引用正确；2 = 所有引用 id 都在片段里且支持该句。
再给 verdict：三维都达到 2 分才 pass，任一维度低于 2 分就是 fail。
reason 用一句中文说明理由。`

const RUBRICS: Record<string, string> = { 'rubric-v1': RUBRIC_V1 }
const DEFAULT_RUBRIC = 'rubric-v1'
const MAX_SNIPPETS = 10
const MAX_SNIPPET_CHARS = 1000

const JudgeSchema = z.object({
  groundedness: z.number().int().min(0).max(2),
  correctness: z.number().int().min(0).max(2),
  citation: z.number().int().min(0).max(2),
  verdict: z.enum(['pass', 'fail']),
  reason: z.string(),
})

function resolveRubric(Value: unknown): Rubric | null {
  if (Value === null || Value === undefined || Value === '') return { version: DEFAULT_RUBRIC, text: RUBRIC_V1 }
  if (typeof Value !== 'string' || !Object.hasOwn(RUBRICS, Value)) return null
  return { version: Value, text: RUBRICS[Value]! }
}

async function judgeCase(
  Model: LanguageModelV4,
  Rubric: Rubric,
  Query: string,
  Answer: string,
  Citations: EvalCitation[],
): Promise<EvalJudgeResult> {
  try {
    const Result = await generateText({
      model: Model,
      output: Output.object({ schema: JudgeSchema }),
      prompt: judgePrompt(Rubric.text, Query, Answer, Citations),
    })
    const Out = Result.output
    return {
      groundedness: Out.groundedness,
      correctness: Out.correctness,
      citation: Out.citation,
      verdict: verdictOfScores(Out.groundedness, Out.correctness, Out.citation),
      reason: Out.reason,
      error: null,
    }
  } catch (Err) {
    return {
      groundedness: null,
      correctness: null,
      citation: null,
      verdict: null,
      reason: '',
      error: Err instanceof Error ? Err.message : String(Err),
    }
  }
}

function verdictOfScores(Groundedness: number, Correctness: number, Citation: number): 'pass' | 'fail' {
  return Groundedness === 2 && Correctness === 2 && Citation === 2 ? 'pass' : 'fail'
}

function judgePrompt(RubricText: string, Query: string, Answer: string, Citations: EvalCitation[]): string {
  const Snippets = Citations
    .slice(0, MAX_SNIPPETS)
    .map((Item) => `[${Item.chunkId.slice(0, 8)}] ${Item.content.slice(0, MAX_SNIPPET_CHARS)}`)
    .join('\n\n')
  return `${RubricText}\n\n## 问题\n${Query}\n\n## 回答\n${Answer}\n\n## 检索片段\n${Snippets === '' ? '（没有检索到片段）' : Snippets}`
}
