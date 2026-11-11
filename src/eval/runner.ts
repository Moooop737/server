/**
 * 评测执行器 —— 进程内单队列：一次只跑一个 run；queued 可取消，running 在 case 之间可中止（检索/回答本身没有 signal）。
 * 一个 run 的执行：startRun → 逐 case（检索 run：校验 gold 前缀 → 检索 → 判分；答案 run：回答 → 断言 → judge → 合成）→ 追加 results → done / cancelled / failed。
 * 模式用快照推断（inferRunMode），不加列；answer run 复用同一只 retriever 与 Chat 核心的 instructions/tools，但不写会话表。
 * 参数只认 run 快照（run_config.config / metric_config.config / rubric），不读 AppConfig；judge 单条失败只记该 case。
 * 队列与运行状态不持久化：重启后由启动清扫把 queued/running 标 cancelled（repo.markInterruptedRuns）。
 */

export { EvalRunner }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { EvalAssembly } from './assembly'
import { EvalWorker } from '../agent/worker/eval'
import { scoreCase, finalVerdict } from './metrics'
import { inferRunMode } from './mode'
import { evaluateAssertions } from './assertions'
import { judgeCase, resolveRubric } from './judge'
import { logError, logInfo } from '../trace/systemtrace/log'
import { RuntimeModelRegistry } from '../adapter/model/runtime-registry'

import type { LanguageModelV4 } from '@ai-sdk/provider'
import type { EvalRunCaseSnapshot, EvalRunResult, EvalRunSnapshot, Repo } from '../adapter/contract'
import type { Rubric } from './judge'
import type { Retriever } from '../retrieve/contracts'

interface QueueItem {
  id: string
  resolve: () => void
}

interface ActiveRun {
  id: string
  aborted: boolean
}

interface AnswerContext {
  model: LanguageModelV4
  judgeModel: LanguageModelV4 | null
  rubric: Rubric | null
  temperature: number
}

@singleton()
class EvalRunner {
  private readonly repo: Repo
  private readonly assembly: EvalAssembly
  private readonly chat: RuntimeModelRegistry
  private retriever!: Retriever
  private worker!: EvalWorker
  private readonly queue: QueueItem[] = []
  private active: ActiveRun | null = null
  private pumping = false

  constructor(@inject(EvalAssembly) Assembly: EvalAssembly, @inject(RuntimeModelRegistry) Chat: RuntimeModelRegistry) {
    this.repo = Assembly.repo
    this.assembly = Assembly
    this.chat = Chat
  }

  enqueue(RunId: string): Promise<void> {
    return new Promise((Resolve) => {
      this.queue.push({ id: RunId, resolve: Resolve })
      void this.pump()
    })
  }

  async cancel(RunId: string): Promise<'queued' | 'running' | 'missing'> {
    if (this.active !== null && this.active.id === RunId) {
      this.active.aborted = true
      return 'running'
    }
    const Index = this.queue.findIndex((Item) => Item.id === RunId)
    if (Index === -1) return 'missing'
    const [Item] = this.queue.splice(Index, 1)
    await this.repo.cancelQueuedRun(RunId)
    Item!.resolve()
    return 'queued'
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const Item = this.queue.shift()!
        const State: ActiveRun = { id: Item.id, aborted: false }
        this.active = State
        try {
          await this.execute(Item.id, State)
        } catch (Err) {
          logError('E_EVAL_RUN', String(Err))
          await this.repo.finishRun(Item.id, 'failed', { duration_ms: 0, error_reason: String(Err) }).catch(() => {})
        } finally {
          this.active = null
          Item.resolve()
        }
      }
    } finally {
      this.pumping = false
    }
  }

  private async execute(RunId: string, State: ActiveRun): Promise<void> {
    const Run = await this.repo.getRun(RunId)
    if (Run === null || Run.status !== 'queued') return

    const Mode = inferRunMode(Run.snapshot)
    const Prepared = Mode === 'answer' ? this.prepareAnswer(Run.snapshot) : null
    if (Prepared !== null && 'error' in Prepared) {
      await this.repo.finishRun(RunId, 'failed', { duration_ms: 0, error_reason: Prepared.error })
      logError('E_EVAL_RUN', `run=${RunId} ${Prepared.error}`)
      return
    }
    const Pipeline = Run.snapshot.pipeline
    if (Pipeline === undefined) {
      await this.repo.finishRun(RunId, 'failed', { duration_ms: 0, error_reason: '运行快照缺管线定义' })
      logError('E_EVAL_RUN', `run=${RunId} 运行快照缺管线定义（旧结构，历史只展示）`)
      return
    }
    if (!await this.repo.startRun(RunId)) return

    this.retriever = this.assembly.retriever({
      nodes: Pipeline.nodes,
      ...(Pipeline.output === null ? {} : { output: Pipeline.output }),
    })
    this.worker = new EvalWorker(this.retriever, this.repo)

    const Started = Date.now()
    logInfo('I_EVAL_RUN_START', `run=${RunId} mode=${Mode} cases=${Run.snapshot.cases.length}`)

    try {
      for (const Case of Run.snapshot.cases) {
        if (State.aborted) break
        const Result = Prepared === null
          ? await this.runCase(Case)
          : await this.runAnswerCase(Case, Prepared)
        await this.repo.appendRunResult(RunId, Result)
      }

      const Duration = Date.now() - Started
      if (State.aborted) {
        await this.repo.finishRun(RunId, 'cancelled', { duration_ms: Duration, error_reason: '已中止' })
        logInfo('I_EVAL_RUN_DONE', `run=${RunId} status=cancelled duration=${Duration}ms`)
        return
      }
      await this.repo.finishRun(RunId, 'done', { duration_ms: Duration })
      logInfo('I_EVAL_RUN_DONE', `run=${RunId} status=done duration=${Duration}ms`)
    } catch (Err) {
      const Duration = Date.now() - Started
      await this.repo.finishRun(RunId, 'failed', {
        duration_ms: Duration,
        error_reason: Err instanceof Error ? Err.message : String(Err),
      })
      logError('E_EVAL_RUN', `run=${RunId} ${String(Err)}`)
    }
  }

  private async runCase(Case: EvalRunCaseSnapshot): Promise<EvalRunResult> {
    const Started = Date.now()
    let missing = 0
    const InvalidGold: EvalRunCaseSnapshot['gold'] = []
    try {
      for (const Gold of Case.gold) {
        const Chunk = await this.repo.getChunkByDataUri(Gold.data_uri, Gold.chunk_index)
        const Prefix = Gold.content_prefix.trim()
        if (Chunk === null || Prefix === '' || !Chunk.content.trim().startsWith(Prefix)) {
          missing += 1
          InvalidGold.push(Gold)
        }
      }
    } catch (Err) {
      return {
        case_key: Case.case_key,
        negative: Case.negative,
        rank: null,
        matched: 0,
        total: Case.negative ? 0 : Case.gold.length,
        hit_count: 0,
        recall: 0,
        mrr: 0,
        missing_gold: 0,
        duration_ms: Date.now() - Started,
        error: Err instanceof Error ? Err.message : String(Err),
      }
    }

    try {
      const Result = await this.retriever.search(Case.query)
      const Score = scoreCase({
        negative: Case.negative,
        gold: Case.gold,
        invalidGold: InvalidGold,
        hits: Result.hits.map((Hit) => ({ data_uri: Hit.dataUri, chunk_index: Hit.chunk.chunk_index })),
      })
      return {
        case_key: Case.case_key,
        negative: Case.negative,
        ...Score,
        hit_count: Result.hits.length,
        missing_gold: missing,
        duration_ms: Date.now() - Started,
        error: null,
      }
    } catch (Err) {
      return {
        case_key: Case.case_key,
        negative: Case.negative,
        rank: null,
        matched: 0,
        total: Case.negative ? 0 : Case.gold.length,
        hit_count: 0,
        recall: 0,
        mrr: 0,
        missing_gold: missing,
        duration_ms: Date.now() - Started,
        error: Err instanceof Error ? Err.message : String(Err),
      }
    }
  }

  private prepareAnswer(Snapshot: EvalRunSnapshot): AnswerContext | { error: string } {
    const ModelName = Snapshot.run_config?.config?.model
    const Model = typeof ModelName === 'string' ? this.chat.resolve(ModelName) : undefined
    if (Model === undefined) return { error: `回答模型不在册: ${String(ModelName)}` }
    const Temperature = Snapshot.run_config?.config?.temperature
    if (typeof Temperature !== 'number' || !Number.isFinite(Temperature) || Temperature < 0 || Temperature > 2) {
      return { error: 'temperature 快照不合法' }
    }

    const JudgeName = Snapshot.metric_config?.config?.judge_model
    if (JudgeName === null || JudgeName === undefined || JudgeName === '') {
      return { model: Model, judgeModel: null, rubric: null, temperature: Temperature }
    }
    if (typeof JudgeName !== 'string') return { error: 'judge_model 需为字符串或 null' }
    const JudgeModel = this.chat.resolve(JudgeName)
    if (JudgeModel === undefined) return { error: `judge 模型不在册: ${JudgeName}` }
    const Rubric = Snapshot.rubric ?? resolveRubric(Snapshot.metric_config?.config?.rubric)
    if (Rubric === null) return { error: 'rubric 版本未知' }
    return { model: Model, judgeModel: JudgeModel, rubric: Rubric, temperature: Temperature }
  }

  private async runAnswerCase(Case: EvalRunCaseSnapshot, Ctx: AnswerContext): Promise<EvalRunResult> {
    const Started = Date.now()
    const Answer = await this.worker.answer(Ctx.model, Case.query, { temperature: Ctx.temperature })
    const HasAssertions = Case.assertions.expect.length + Case.assertions.reject.length > 0
    const Assertion = Answer.error !== null || !HasAssertions ? null : evaluateAssertions(Answer.answer, Case.assertions)
    const Judge = Case.negative || Ctx.judgeModel === null || Ctx.rubric === null || Answer.error !== null
      ? null
      : await judgeCase(Ctx.judgeModel, Ctx.rubric, Case.query, Answer.answer, Answer.citations)

    const Base: EvalRunResult = {
      case_key: Case.case_key,
      negative: Case.negative,
      rank: null,
      matched: 0,
      total: 0,
      hit_count: Answer.citations.length,
      recall: 0,
      mrr: 0,
      missing_gold: 0,
      duration_ms: Date.now() - Started,
      error: Answer.error,
      answer: Answer.answer,
      citations: Answer.citations,
      assertion: Assertion,
      judge: Judge,
      verdict: null,
    }
    return { ...Base, verdict: Answer.error !== null ? 'fail' : finalVerdict(Base, undefined) }
  }
}


