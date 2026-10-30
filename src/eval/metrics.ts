/**
 * 检索评测的判分口径 —— 纯函数，不碰库、不碰网络。
 * 正例：gold 按 (data_uri, chunk_index) 去重后逐条在 top-k 命中里找；matched/total 是 gold 覆盖率，rank 取最早命中的名次。
 * 负例：一条都不命中才算成功（recall=1、mrr=1）；命中任意一条即失败（0/0）。
 * 缺失 gold（资源被删/重灌导致前缀对不上）仍计入分母，由调用方算好 missing_gold 一并展示。
 * 聚合：平均 recall / 平均 MRR / 失败数（recall<=0）/ 总耗时（逐条相加）。
 */

export { scoreCase, summarizeResults, finalVerdict, summarizeAnswerResults }
export type { CaseScoreInput, CaseScore, SummarizableResult, EvalSummary, AnswerResultLike, HumanVerdict, EvalAnswerSummary }

import type { EvalAssertionResult, EvalJudgeResult, EvalVerdict } from '../adapter/contract'

interface GoldIdentity {
  data_uri: string
  chunk_index: number
}

interface HitIdentity {
  data_uri: string
  chunk_index: number
}

interface CaseScoreInput {
  negative: boolean
  gold: GoldIdentity[]
  invalidGold?: GoldIdentity[]
  hits: HitIdentity[]
}

interface CaseScore {
  rank: number | null
  matched: number
  total: number
  recall: number
  mrr: number
}

interface SummarizableResult {
  recall: number
  mrr: number
  duration_ms: number
}

interface EvalSummary {
  recall: number
  mrr: number
  failed: number
  duration_ms: number
  total: number
}

interface AnswerResultLike {
  case_key: string
  duration_ms: number
  error: string | null
  assertion?: EvalAssertionResult | null
  judge?: EvalJudgeResult | null
  verdict?: EvalVerdict | null
}

interface HumanVerdict {
  case_key: string
  verdict: 'pass' | 'fail'
}

interface EvalAnswerSummary {
  total: number
  failed: number
  duration_ms: number
  pass: number
  fail: number
  unscored: number
  assertion: { scored: number; passed: number; rate: number | null }
  judge: {
    scored: number
    passed: number
    rate: number | null
    errored: number
    unjudged: number
    groundedness: number | null
    correctness: number | null
    citation: number | null
  }
  human: { reviewed: number; compared: number; agree: number; rate: number | null }
  levels: { level: string; reviewed: number; compared: number; agree: number; rate: number | null }[]
}

function scoreCase(Input: CaseScoreInput): CaseScore {
  if (Input.negative) {
    const Clean = Input.hits.length === 0
    return { rank: null, matched: 0, total: 0, recall: Clean ? 1 : 0, mrr: Clean ? 1 : 0 }
  }

  const Gold = uniqueGold(Input.gold)
  if (Gold.length === 0) return { rank: null, matched: 0, total: 0, recall: 0, mrr: 0 }
  const Invalid = new Set((Input.invalidGold ?? []).map(keyOf))

  const RankByKey = new Map<string, number>()
  Input.hits.forEach((Hit, Index) => {
    const Key = keyOf(Hit)
    if (!RankByKey.has(Key)) RankByKey.set(Key, Index + 1)
  })

  let matched = 0
  let rank: number | null = null
  for (const Item of Gold) {
    if (Invalid.has(keyOf(Item))) continue
    const Found = RankByKey.get(keyOf(Item))
    if (Found === undefined) continue
    matched += 1
    rank = rank === null ? Found : Math.min(rank, Found)
  }

  return {
    rank,
    matched,
    total: Gold.length,
    recall: matched / Gold.length,
    mrr: rank === null ? 0 : 1 / rank,
  }
}

function summarizeResults(Results: SummarizableResult[]): EvalSummary {
  if (Results.length === 0) return { recall: 0, mrr: 0, failed: 0, duration_ms: 0, total: 0 }
  let recall = 0
  let mrr = 0
  let failed = 0
  let duration = 0
  for (const Item of Results) {
    recall += Item.recall
    mrr += Item.mrr
    duration += Item.duration_ms
    if (Item.recall <= 0) failed += 1
  }
  return { recall: recall / Results.length, mrr: mrr / Results.length, failed, duration_ms: duration, total: Results.length }
}

function finalVerdict(Result: AnswerResultLike, Human: HumanVerdict | undefined): EvalVerdict {
  if (Result.error !== null) return 'fail'
  const Assertion = Result.assertion ?? null
  if (Assertion !== null && !Assertion.passed) return 'fail'

  const Judge = Result.judge ?? null
  const JudgeVerdict = Judge !== null && Judge.error === null && Judge.verdict !== null ? Judge.verdict : null
  const HumanVerdict = Human?.verdict ?? null

  if (JudgeVerdict !== null && HumanVerdict !== null) {
    return JudgeVerdict === 'pass' && HumanVerdict === 'pass' ? 'pass' : 'fail'
  }
  if (HumanVerdict !== null) return HumanVerdict
  if (JudgeVerdict !== null) return JudgeVerdict
  return Assertion !== null ? 'pass' : 'unscored'
}

function summarizeAnswerResults(
  Results: AnswerResultLike[],
  Humans: HumanVerdict[],
  Cases: { case_key: string; level: string }[] = [],
): EvalAnswerSummary {
  const HumanByCase = new Map(Humans.map((Item) => [Item.case_key, Item]))
  const LevelByCase = new Map(Cases.map((Item) => [Item.case_key, Item.level]))
  const LevelStats = new Map<string, { reviewed: number; compared: number; agree: number }>()
  let pass = 0
  let fail = 0
  let unscored = 0
  let failed = 0
  let duration = 0
  let assertionScored = 0
  let assertionPassed = 0
  let judgeScored = 0
  let judgePassed = 0
  let judgeErrored = 0
  let judgeUnjudged = 0
  let groundedness = 0
  let groundednessCount = 0
  let correctness = 0
  let correctnessCount = 0
  let citation = 0
  let citationCount = 0
  let reviewed = 0
  let compared = 0
  let agree = 0

  for (const Result of Results) {
    duration += Result.duration_ms
    if (Result.error !== null) failed += 1

    const Final = finalVerdict(Result, HumanByCase.get(Result.case_key))
    if (Final === 'pass') pass += 1
    else if (Final === 'fail') fail += 1
    else unscored += 1

    const Assertion = Result.assertion ?? null
    if (Assertion !== null) {
      assertionScored += 1
      if (Assertion.passed) assertionPassed += 1
    }

    const Judge = Result.judge ?? null
    const JudgeUsable = Judge !== null && Judge.error === null && Judge.verdict !== null
    if (Judge === null) judgeUnjudged += 1
    else if (Judge.error !== null) judgeErrored += 1
    if (Judge !== null && JudgeUsable) {
      judgeScored += 1
      if (Judge.verdict === 'pass') judgePassed += 1
      if (Judge.groundedness !== null) {
        groundedness += Judge.groundedness
        groundednessCount += 1
      }
      if (Judge.correctness !== null) {
        correctness += Judge.correctness
        correctnessCount += 1
      }
      if (Judge.citation !== null) {
        citation += Judge.citation
        citationCount += 1
      }
    }

    const Human = HumanByCase.get(Result.case_key)
    if (Human !== undefined) {
      reviewed += 1
      if (JudgeUsable) {
        compared += 1
        if (Human.verdict === Judge!.verdict) agree += 1
      }
      const Level = LevelByCase.get(Result.case_key)
      if (Level !== undefined) {
        const Stat = LevelStats.get(Level) ?? { reviewed: 0, compared: 0, agree: 0 }
        Stat.reviewed += 1
        if (JudgeUsable) {
          Stat.compared += 1
          if (Human.verdict === Judge!.verdict) Stat.agree += 1
        }
        LevelStats.set(Level, Stat)
      }
    }
  }

  return {
    total: Results.length,
    failed,
    duration_ms: duration,
    pass,
    fail,
    unscored,
    assertion: { scored: assertionScored, passed: assertionPassed, rate: assertionScored === 0 ? null : assertionPassed / assertionScored },
    judge: {
      scored: judgeScored,
      passed: judgePassed,
      rate: judgeScored === 0 ? null : judgePassed / judgeScored,
      errored: judgeErrored,
      unjudged: judgeUnjudged,
      groundedness: groundednessCount === 0 ? null : groundedness / groundednessCount,
      correctness: correctnessCount === 0 ? null : correctness / correctnessCount,
      citation: citationCount === 0 ? null : citation / citationCount,
    },
    human: { reviewed, compared, agree, rate: compared === 0 ? null : agree / compared },
    levels: [...LevelStats.entries()]
      .sort(([A], [B]) => A.localeCompare(B))
      .map(([Level, Stat]) => ({ level: Level, ...Stat, rate: Stat.compared === 0 ? null : Stat.agree / Stat.compared })),
  }
}

function keyOf(Item: GoldIdentity): string {
  return `${Item.data_uri}#${Item.chunk_index}`
}

function uniqueGold(Gold: GoldIdentity[]): GoldIdentity[] {
  const Seen = new Set<string>()
  const Out: GoldIdentity[] = []
  for (const Item of Gold) {
    const Key = keyOf(Item)
    if (Seen.has(Key)) continue
    Seen.add(Key)
    Out.push(Item)
  }
  return Out
}
