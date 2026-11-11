/**
 * 评测路由 —— 7.1 的题集/配置维护 + 7.0 的状态与检索验证。
 * 表住「选中的库」：写一律经 EvalAssembly.repo（共享=主库，隔离=评测库）；不用 hono-crud（它固定主库 orm）。
 * GET /status 先注册、trace 壳后注册：Hono 的 use('*') 只作用于其后注册的路由，状态查询不落 trace。
 * 校验住本层：名称/query/level 非空、gold 形状、负例 gold 必须空、model/judge_model 必须在 /models 在册、配置键与数值范围。
 * 数据集有 run 时删除 409 并给出 runs 数；复制的数据集/配置由 repo 自动找名字空位。
 * 基线采纳只接属于该数据集且状态 done 的 run（OQ-7.3-3）；换基线是显式动作，run 跑完不改基线。
 */

export { EvalRoute }

import 'reflect-metadata'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { inject, injectable } from 'tsyringe'
import { EvalAssembly } from '../eval/assembly'
import { RetrieveRoute } from './retrieve'
import { createEndpointTrace } from '../trace/systemtrace/endpoint'
import { logError } from '../trace/systemtrace/log'
import { RuntimeModelRegistry, RuntimeRegistryError } from '../adapter/model/runtime-registry'
import { CONTENT_PREFIX_LENGTH } from '../eval/cases'
import { EvalRunner } from '../eval/runner'
import { summarizeResults, summarizeAnswerResults, finalVerdict } from '../eval/metrics'
import { buildSnapshot } from '../eval/snapshot'
import { inferRunMode } from '../eval/mode'
import { resolveRubric } from '../eval/judge'

import type { EvalAssertion, EvalAssertions, EvalCase, EvalCaseInput, EvalConfig, EvalConfigKind, EvalGold, EvalHumanResult, EvalRun, Repo } from '../adapter/contract'
import { RuntimeRetrievalRegistry } from '../adapter/contract'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RUN_CONFIG_KEYS: readonly string[] = ['model', 'temperature']
const METRIC_CONFIG_KEYS: readonly string[] = ['judge_model', 'rubric', 'metrics']

@injectable()
class EvalRoute {
  private readonly assembly: EvalAssembly
  private readonly runner: EvalRunner
  private readonly registry: RuntimeModelRegistry
  private readonly retrieval: RuntimeRetrievalRegistry

  constructor(
    @inject(EvalAssembly) Assembly: EvalAssembly,
    @inject(EvalRunner) Runner: EvalRunner,
    @inject(RuntimeModelRegistry) Registry: RuntimeModelRegistry,
    @inject(RuntimeRetrievalRegistry) Retrieval: RuntimeRetrievalRegistry,
  ) {
    this.assembly = Assembly
    this.runner = Runner
    this.registry = Registry
    this.retrieval = Retrieval
  }

  build(): Hono {
    const app = new Hono()
    const repo = this.assembly.repo
    const mode = this.assembly.mode
    const models = () => new Set(this.registry.catalog().map((Item) => Item.id))

    app.get('/status', async (c) => {
      const reachable = await repo.ping()
      let corpus = null
      if (reachable) {
        try {
          corpus = await repo.resourceCounts()
        } catch (err) {
          logError('E_EVAL_CORPUS', String(err))
        }
      }
      return c.json({ mode, reachable, corpus })
    })

    app.use('*', createEndpointTrace(repo))
    app.route('/retrieve', new RetrieveRoute({ retriever: () => this.assembly.retriever(this.retrieval.current().pipeline) }, repo).build())
    buildDatasets(app, repo)
    buildCases(app, repo)
    buildConfigs(app, repo, models)
    buildRuns(app, { repo, runner: this.runner, registry: this.registry, retrieval: this.retrieval })

    return app
  }
}

function buildDatasets(app: Hono, repo: Repo): Hono {
  app.get('/datasets', async (c) => {
    try {
      return c.json({ datasets: await repo.listDatasets() })
    } catch (err) {
      logError('E_EVAL_DATASET_LIST', String(err))
      return c.json({ code: 'E_EVAL_DATASET_LIST', message: '读取数据集失败' }, 500)
    }
  })

  app.post('/datasets', async (c) => {
    const Body = await readObject(c)
    if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
    const Name = nonEmptyString(Body.name)
    if (Name === null) return bad(c, 'E_EVAL_NAME', 'name 必填且为非空字符串')
    if (Body.note !== undefined && typeof Body.note !== 'string') return bad(c, 'E_BAD_BODY', 'note 需为字符串')
    try {
      const Dataset = await repo.createDataset({ name: Name, note: typeof Body.note === 'string' ? Body.note : '' })
      return c.json({ dataset: Dataset }, 201)
    } catch (err) {
      return mapWriteError(c, err, 'E_EVAL_DATASET_CREATE', '新建数据集失败')
    }
  })

  app.patch('/datasets/:id', async (c) => {
    const Id = c.req.param('id')
    if (!UUID_RE.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
    const Existing = await repo.getDataset(Id)
    if (Existing === null) return notFound(c, '数据集不存在')
    const Body = await readObject(c)
    if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
    const Name = Body.name === undefined ? Existing.name : nonEmptyString(Body.name)
    if (Name === null) return bad(c, 'E_EVAL_NAME', 'name 必填且为非空字符串')
    if (Body.note !== undefined && typeof Body.note !== 'string') return bad(c, 'E_BAD_BODY', 'note 需为字符串')
    try {
      const Dataset = await repo.updateDataset(Id, { name: Name, note: typeof Body.note === 'string' ? Body.note : Existing.note })
      return Dataset === null ? notFound(c, '数据集不存在') : c.json({ dataset: Dataset })
    } catch (err) {
      return mapWriteError(c, err, 'E_EVAL_DATASET_UPDATE', '更新数据集失败')
    }
  })

  app.put('/datasets/:id/baseline', async (c) => {
    const Id = c.req.param('id')
    if (!UUID_RE.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
    const Body = await readObject(c)
    if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
    if (typeof Body.run_id !== 'string' || !UUID_RE.test(Body.run_id)) return bad(c, 'E_BAD_ID', 'run_id 需为 UUID')
    try {
      const Dataset = await repo.getDataset(Id)
      if (Dataset === null) return notFound(c, '数据集不存在')
      const Run = await repo.getRun(Body.run_id)
      if (Run === null) return notFound(c, '运行不存在')
      if (Run.dataset_id !== Id) return bad(c, 'E_EVAL_BASELINE_DATASET', '运行不属于该数据集')
      if (Run.status !== 'done') {
        return c.json({ code: 'E_EVAL_RUN_NOT_DONE', message: '只有完成的运行才能当基线' }, 409)
      }
      const Updated = await repo.setDatasetBaseline(Id, Run.id)
      return Updated === null ? notFound(c, '数据集不存在') : c.json({ dataset: Updated })
    } catch (err) {
      logError('E_EVAL_BASELINE_SET', String(err))
      return c.json({ code: 'E_EVAL_BASELINE_SET', message: '采纳基线失败' }, 500)
    }
  })

  app.delete('/datasets/:id', async (c) => {
    const Id = c.req.param('id')
    if (!UUID_RE.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
    try {
      const Runs = await repo.countRunsOfDataset(Id)
      if (Runs > 0) {
        return c.json({ code: 'E_EVAL_DATASET_HAS_RUNS', message: `先删掉关联的 ${Runs} 次运行`, runs: Runs }, 409)
      }
      const Deleted = await repo.deleteDataset(Id)
      return Deleted ? c.body(null, 204) : notFound(c, '数据集不存在')
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        const Runs = await repo.countRunsOfDataset(Id).catch(() => null)
        return c.json({
          code: 'E_EVAL_DATASET_HAS_RUNS',
          message: Runs === null ? '先删掉关联的运行' : `先删掉关联的 ${Runs} 次运行`,
          runs: Runs,
        }, 409)
      }
      logError('E_EVAL_DATASET_DELETE', String(err))
      return c.json({ code: 'E_EVAL_DATASET_DELETE', message: '删除数据集失败' }, 500)
    }
  })

  app.post('/datasets/:id/copy', async (c) => {
    const Id = c.req.param('id')
    if (!UUID_RE.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
    try {
      const Dataset = await repo.duplicateDataset(Id)
      return Dataset === null ? notFound(c, '数据集不存在') : c.json({ dataset: Dataset }, 201)
    } catch (err) {
      return mapWriteError(c, err, 'E_EVAL_DATASET_COPY', '复制数据集失败')
    }
  })

  app.get('/datasets/:id/cases', async (c) => {
    const Id = c.req.param('id')
    if (!UUID_RE.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
    const Existing = await repo.getDataset(Id)
    if (Existing === null) return notFound(c, '数据集不存在')
    try {
      return c.json({ cases: await repo.listCases(Id) })
    } catch (err) {
      logError('E_EVAL_CASE_LIST', String(err))
      return c.json({ code: 'E_EVAL_CASE_LIST', message: '读取 case 失败' }, 500)
    }
  })

  app.post('/datasets/:id/cases', async (c) => {
    const Id = c.req.param('id')
    if (!UUID_RE.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
    const Existing = await repo.getDataset(Id)
    if (Existing === null) return notFound(c, '数据集不存在')
    const Body = await readObject(c)
    if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
    const Parsed = parseCaseCreate(Body)
    if (!Parsed.ok) return bad(c, 'E_EVAL_CASE', Parsed.message)
    try {
      const CaseItem = await repo.createCase(Id, Parsed.data)
      return c.json({ case: CaseItem }, 201)
    } catch (err) {
      return mapWriteError(c, err, 'E_EVAL_CASE_CREATE', '新建 case 失败', 'E_EVAL_CASE_KEY', 'case_key 在该数据集已存在')
    }
  })

  return app
}

function buildCases(app: Hono, repo: Repo): Hono {
  app.patch('/cases/:id', async (c) => {
    const Id = c.req.param('id')
    if (!UUID_RE.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
    const Existing = await repo.getCase(Id)
    if (Existing === null) return notFound(c, 'case 不存在')
    const Body = await readObject(c)
    if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
    const Parsed = mergeCase(Existing, Body)
    if (!Parsed.ok) return bad(c, 'E_EVAL_CASE', Parsed.message)
    try {
      const CaseItem = await repo.updateCase(Id, Parsed.data)
      return CaseItem === null ? notFound(c, 'case 不存在') : c.json({ case: CaseItem })
    } catch (err) {
      return mapWriteError(c, err, 'E_EVAL_CASE_UPDATE', '更新 case 失败')
    }
  })

  app.delete('/cases/:id', async (c) => {
    const Id = c.req.param('id')
    if (!UUID_RE.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
    try {
      const Deleted = await repo.deleteCase(Id)
      return Deleted ? c.body(null, 204) : notFound(c, 'case 不存在')
    } catch (err) {
      logError('E_EVAL_CASE_DELETE', String(err))
      return c.json({ code: 'E_EVAL_CASE_DELETE', message: '删除 case 失败' }, 500)
    }
  })

  return app
}

function buildConfigs(app: Hono, repo: Repo, models: () => Set<string>): Hono {
  app.get('/configs', async (c) => {
    const Kind = c.req.query('kind')
    if (Kind !== 'run' && Kind !== 'metric') return bad(c, 'E_EVAL_KIND', 'kind 需为 run 或 metric')
    try {
      return c.json({ configs: await repo.listConfigs(Kind) })
    } catch (err) {
      logError('E_EVAL_CONFIG_LIST', String(err))
      return c.json({ code: 'E_EVAL_CONFIG_LIST', message: '读取配置失败' }, 500)
    }
  })

  app.post('/configs', async (c) => {
    const Body = await readObject(c)
    if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
    const Kind = Body.kind
    if (Kind !== 'run' && Kind !== 'metric') return bad(c, 'E_EVAL_KIND', 'kind 需为 run 或 metric')
    const Name = nonEmptyString(Body.name)
    if (Name === null) return bad(c, 'E_EVAL_NAME', 'name 必填且为非空字符串')
    const Parsed = parseConfig(Kind, Body.config, models())
    if (!Parsed.ok) return bad(c, 'E_EVAL_CONFIG', Parsed.message)
    try {
      const Config = await repo.createConfig({ kind: Kind, name: Name, config: Parsed.config })
      return c.json({ config: Config }, 201)
    } catch (err) {
      return mapWriteError(c, err, 'E_EVAL_CONFIG_CREATE', '新建配置失败')
    }
  })

  app.patch('/configs/:id', async (c) => {
    const Id = c.req.param('id')
    if (!UUID_RE.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
    const Existing = await repo.getConfig(Id)
    if (Existing === null) return notFound(c, '配置不存在')
    const Body = await readObject(c)
    if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
    if (Body.kind !== undefined) return bad(c, 'E_EVAL_KIND', 'kind 不可修改')
    const Name = Body.name === undefined ? Existing.name : nonEmptyString(Body.name)
    if (Name === null) return bad(c, 'E_EVAL_NAME', 'name 必填且为非空字符串')
    let Config = Existing.config
    if (Body.config !== undefined) {
      const Parsed = parseConfig(Existing.kind, Body.config, models())
      if (!Parsed.ok) return bad(c, 'E_EVAL_CONFIG', Parsed.message)
      Config = Parsed.config
    }
    try {
      const Updated = await repo.updateConfig(Id, { name: Name, config: Config })
      return Updated === null ? notFound(c, '配置不存在') : c.json({ config: Updated })
    } catch (err) {
      return mapWriteError(c, err, 'E_EVAL_CONFIG_UPDATE', '更新配置失败')
    }
  })

  app.delete('/configs/:id', async (c) => {
    const Id = c.req.param('id')
    if (!UUID_RE.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
    try {
      const Deleted = await repo.deleteConfig(Id)
      return Deleted ? c.body(null, 204) : notFound(c, '配置不存在')
    } catch (err) {
      logError('E_EVAL_CONFIG_DELETE', String(err))
      return c.json({ code: 'E_EVAL_CONFIG_DELETE', message: '删除配置失败' }, 500)
    }
  })

  app.post('/configs/:id/copy', async (c) => {
    const Id = c.req.param('id')
    if (!UUID_RE.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
    try {
      const Config = await repo.duplicateConfig(Id)
      return Config === null ? notFound(c, '配置不存在') : c.json({ config: Config }, 201)
    } catch (err) {
      return mapWriteError(c, err, 'E_EVAL_CONFIG_COPY', '复制配置失败')
    }
  })

  return app
}

interface RunRouteDeps {
  repo: Repo
  runner: EvalRunner
  registry: RuntimeModelRegistry
  retrieval: RuntimeRetrievalRegistry
}

function buildRuns(app: Hono, Deps: RunRouteDeps): Hono {
  const { repo, runner, registry, retrieval } = Deps

  app.post('/runs', async (c) => {
    const Body = await readObject(c)
    if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
    if (typeof Body.dataset_id !== 'string' || !UUID_RE.test(Body.dataset_id)) return bad(c, 'E_BAD_ID', 'dataset_id 需为 UUID')
    if (typeof Body.run_config_id !== 'string' || !UUID_RE.test(Body.run_config_id)) return bad(c, 'E_BAD_ID', 'run_config_id 需为 UUID')
    if (typeof Body.metric_config_id !== 'string' || !UUID_RE.test(Body.metric_config_id)) return bad(c, 'E_BAD_ID', 'metric_config_id 需为 UUID')
    if (Body.mode !== undefined && Body.mode !== 'retrieval' && Body.mode !== 'answer') {
      return bad(c, 'E_EVAL_MODE', 'mode 需为 retrieval 或 answer')
    }
    const Mode = Body.mode as 'retrieval' | 'answer' | undefined

    try {
      const Dataset = await repo.getDataset(Body.dataset_id)
      if (Dataset === null) return notFound(c, '数据集不存在')
      const RunConfig = await repo.getConfig(Body.run_config_id)
      if (RunConfig === null) return notFound(c, '运行配置不存在')
      if (RunConfig.kind !== 'run') return bad(c, 'E_EVAL_CONFIG_KIND', 'run_config_id 不是运行配置')
      const MetricConfig = await repo.getConfig(Body.metric_config_id)
      if (MetricConfig === null) return notFound(c, '测评配置不存在')
      if (MetricConfig.kind !== 'metric') return bad(c, 'E_EVAL_CONFIG_KIND', 'metric_config_id 不是测评配置')
      const JudgeName = MetricConfig.config.judge_model
      if (typeof JudgeName === 'string' && JudgeName.trim() !== '' && resolveRubric(MetricConfig.config.rubric) === null) {
        return bad(c, 'E_EVAL_RUBRIC', 'rubric 版本未知')
      }

      const Cases = await repo.listCases(Dataset.id)
      if (Cases.length === 0) return bad(c, 'E_EVAL_DATASET_EMPTY', '数据集没有 case，先添加题目')

      let Embedding
      try {
        Embedding = registry.requireEmbeddingDefault()
      } catch (Err) {
        if (Err instanceof RuntimeRegistryError) {
          return c.json({ code: 'E_NO_EMBEDDING_MODEL', message: '未配置可用的默认嵌入模型' }, 409)
        }
        throw Err
      }

      if (Embedding.dimensions === null) {
        return c.json({ code: 'E_NO_EMBEDDING_MODEL', message: '未配置可用的默认嵌入模型' }, 409)
      }
      const Pipeline = retrieval.current()
      const Snapshot = buildSnapshot({
        dataset: Dataset,
        cases: Cases,
        runConfig: RunConfig,
        metricConfig: MetricConfig,
        ...(Mode === undefined ? {} : { mode: Mode }),
        embedding: { model: Embedding.model_id, dimensions: Embedding.dimensions },
        corpus: await repo.resourceCounts(),
        pipeline: { version: Pipeline.version, nodes: Pipeline.pipeline.nodes, output: Pipeline.pipeline.output ?? null },
      })
      const Run = await repo.createRun({
        dataset_id: Dataset.id,
        run_config_id: RunConfig.id,
        metric_config_id: MetricConfig.id,
        snapshot: Snapshot,
      })
      void runner.enqueue(Run.id)
      return c.json({ run: Run }, 201)
    } catch (err) {
      logError('E_EVAL_RUN_CREATE', String(err))
      return c.json({ code: 'E_EVAL_RUN_CREATE', message: '新建运行失败' }, 500)
    }
  })

  app.get('/runs', async (c) => {
    const DatasetId = c.req.query('dataset_id')
    if (DatasetId !== undefined && !UUID_RE.test(DatasetId)) return bad(c, 'E_BAD_ID', 'dataset_id 需为 UUID')
    const RunConfigId = c.req.query('run_config_id')
    if (RunConfigId !== undefined && !UUID_RE.test(RunConfigId)) return bad(c, 'E_BAD_ID', 'run_config_id 需为 UUID')
    try {
      const Runs = await repo.listRuns(DatasetId ?? null, RunConfigId ?? null)
      return c.json({ runs: Runs.map(runListItem) })
    } catch (err) {
      logError('E_EVAL_RUN_LIST', String(err))
      return c.json({ code: 'E_EVAL_RUN_LIST', message: '读取运行列表失败' }, 500)
    }
  })

  app.get('/runs/:id', async (c) => {
    const Id = c.req.param('id')
    if (!UUID_RE.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
    try {
      const Run = await repo.getRun(Id)
      if (Run === null) return notFound(c, '运行不存在')
      const { mode: Mode, summary: Summary } = summarizeForRun(Run)
      const Results = Mode === 'answer'
        ? Run.results.map((Item) => ({ ...Item, final_verdict: finalVerdict(Item, Run.human_results.find((Human) => Human.case_key === Item.case_key)) }))
        : Run.results
      return c.json({ run: { ...Run, results: Results }, summary: Summary, mode: Mode })
    } catch (err) {
      logError('E_EVAL_RUN_READ', String(err))
      return c.json({ code: 'E_EVAL_RUN_READ', message: '读取运行失败' }, 500)
    }
  })

  app.post('/runs/:id/cancel', async (c) => {
    const Id = c.req.param('id')
    if (!UUID_RE.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
    try {
      const Run = await repo.getRun(Id)
      if (Run === null) return notFound(c, '运行不存在')
      if (Run.status === 'done' || Run.status === 'failed' || Run.status === 'cancelled') {
        return c.json({ code: 'E_EVAL_RUN_TERMINAL', message: '运行已结束，不能取消' }, 409)
      }

      const Outcome = await runner.cancel(Id)
      if (Outcome === 'missing') {
        if (Run.status === 'queued') await repo.cancelQueuedRun(Id)
        else return c.json({ code: 'E_EVAL_RUN_NOT_ACTIVE', message: '运行不在本进程队列里；如刚重启请刷新列表' }, 409)
      }
      return c.json({ run: await repo.getRun(Id) }, Outcome === 'running' ? 202 : 200)
    } catch (err) {
      logError('E_EVAL_RUN_CANCEL', String(err))
      return c.json({ code: 'E_EVAL_RUN_CANCEL', message: '取消运行失败' }, 500)
    }
  })

  app.put('/runs/:id/human', async (c) => {
    const Id = c.req.param('id')
    if (!UUID_RE.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
    const Body = await readObject(c)
    if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
    const CaseKey = nonEmptyString(Body.case_key)
    if (CaseKey === null) return bad(c, 'E_EVAL_HUMAN', 'case_key 必填且为非空字符串')
    const Verdict = Body.verdict === 'pass' ? 'pass' : Body.verdict === 'fail' ? 'fail' : null
    if (Verdict === null) return bad(c, 'E_EVAL_HUMAN', 'verdict 需为 pass 或 fail')
    if (Body.note !== undefined && typeof Body.note !== 'string') return bad(c, 'E_EVAL_HUMAN', 'note 需为字符串')
    const Groundedness = parseHumanScore(Body.groundedness)
    const Correctness = parseHumanScore(Body.correctness)
    const Citation = parseHumanScore(Body.citation)
    if (!Groundedness.ok || !Correctness.ok || !Citation.ok) {
      return bad(c, 'E_EVAL_HUMAN', '三维分数需为 0..2 的整数或 null')
    }
    try {
      const Run = await repo.getRun(Id)
      if (Run === null) return notFound(c, '运行不存在')
      if (Run.status !== 'done') return c.json({ code: 'E_EVAL_RUN_NOT_DONE', message: '只有完成的运行才能人工复核' }, 409)
      if (inferRunMode(Run.snapshot) !== 'answer') return bad(c, 'E_EVAL_NOT_ANSWER', '检索运行没有人工复核')
      if (!Run.snapshot.cases.some((Item) => Item.case_key === CaseKey)) return notFound(c, 'case 不存在')
      const Entry: EvalHumanResult = {
        case_key: CaseKey,
        verdict: Verdict,
        groundedness: Groundedness.value,
        correctness: Correctness.value,
        citation: Citation.value,
        note: typeof Body.note === 'string' ? Body.note.slice(0, 500) : '',
        updated_at: new Date().toISOString(),
      }
      const Human = await repo.setHumanResult(Id, Entry)
      return Human === null ? notFound(c, '运行不存在') : c.json({ human_results: Human })
    } catch (err) {
      logError('E_EVAL_HUMAN_SET', String(err))
      return c.json({ code: 'E_EVAL_HUMAN_SET', message: '保存人工复核失败' }, 500)
    }
  })

  app.delete('/runs/:id', async (c) => {
    const Id = c.req.param('id')
    if (!UUID_RE.test(Id)) return bad(c, 'E_BAD_ID', 'id 需为 UUID')
    try {
      const Run = await repo.getRun(Id)
      if (Run === null) return notFound(c, '运行不存在')
      if (Run.status === 'queued' || Run.status === 'running') {
        return c.json({ code: 'E_EVAL_RUN_ACTIVE', message: '先中止再删除' }, 409)
      }
      const Deleted = await repo.deleteRun(Id)
      return Deleted ? c.body(null, 204) : notFound(c, '运行不存在')
    } catch (err) {
      logError('E_EVAL_RUN_DELETE', String(err))
      return c.json({ code: 'E_EVAL_RUN_DELETE', message: '删除运行失败' }, 500)
    }
  })

  return app
}

function summarizeForRun(Run: EvalRun): { mode: ReturnType<typeof inferRunMode>; summary: ReturnType<typeof summarizeResults> | object } {
  const Mode = inferRunMode(Run.snapshot)
  if (Mode === 'retrieval') return { mode: Mode, summary: summarizeResults(Run.results) }
  const AnswerSummary = summarizeAnswerResults(Run.results, Run.human_results, Run.snapshot.cases)
  return {
    mode: Mode,
    summary: {
      recall: 0,
      mrr: 0,
      failed: AnswerSummary.failed,
      duration_ms: AnswerSummary.duration_ms,
      total: AnswerSummary.total,
      answer: AnswerSummary,
    },
  }
}

function runListItem(Run: EvalRun) {
  const { mode: Mode, summary: Summary } = summarizeForRun(Run)
  return {
    id: Run.id,
    dataset_id: Run.dataset_id,
    status: Run.status,
    mode: Mode,
    created_at: Run.created_at,
    started_at: Run.started_at,
    ended_at: Run.ended_at,
    duration_ms: Run.duration_ms,
    error_reason: Run.error_reason,
    run_config_name: Run.snapshot?.run_config?.name ?? null,
    metric_config_name: Run.snapshot?.metric_config?.name ?? null,
    summary: Summary,
  }
}

async function readObject(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const Body = await c.req.json()
    return Body !== null && typeof Body === 'object' && !Array.isArray(Body) ? Body as Record<string, unknown> : null
  } catch {
    return null
  }
}

function bad(c: Context, Code: string, Message: string) {
  return c.json({ code: Code, message: Message }, 400)
}

function notFound(c: Context, Message: string) {
  return c.json({ code: 'E_NOT_FOUND', message: Message }, 404)
}

function mapWriteError(c: Context, err: unknown, Fallback: string, Message: string, UniqueCode = 'E_EVAL_NAME_TAKEN', UniqueMessage = '名称已被占用') {
  if (isUniqueViolation(err)) return c.json({ code: UniqueCode, message: UniqueMessage }, 409)
  logError(Fallback, String(err))
  return c.json({ code: Fallback, message: Message }, 500)
}

function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505'
}

function isForeignKeyViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23503'
}

// Drizzle 把 pg 错误包进 DrizzleQueryError.cause；逐层取 code，顶层与内层都能认
function pgErrorCode(Err: unknown): string | null {
  let Current: unknown = Err
  while (typeof Current === 'object' && Current !== null) {
    const Code = (Current as { code?: unknown }).code
    if (typeof Code === 'string') return Code
    Current = (Current as { cause?: unknown }).cause
  }
  return null
}

function nonEmptyString(Value: unknown): string | null {
  if (typeof Value !== 'string') return null
  const Trimmed = Value.trim()
  return Trimmed === '' ? null : Trimmed
}

function parseGold(Value: unknown): EvalGold[] | null {
  if (!Array.isArray(Value)) return null
  const Gold: EvalGold[] = []
  for (const Item of Value) {
    if (Item === null || typeof Item !== 'object' || Array.isArray(Item)) return null
    const Row = Item as Record<string, unknown>
    if (nonEmptyString(Row.data_uri) === null) return null
    if (typeof Row.chunk_index !== 'number' || !Number.isInteger(Row.chunk_index) || Row.chunk_index < 0) return null
    if (nonEmptyString(Row.content_prefix) === null) return null
    Gold.push({
      data_uri: (Row.data_uri as string).trim(),
      chunk_index: Row.chunk_index,
      content_prefix: (Row.content_prefix as string).trim().slice(0, CONTENT_PREFIX_LENGTH),
    })
  }
  return Gold
}

function parseAssertions(Value: unknown): { ok: true; data: EvalAssertions } | { ok: false; message: string } {
  if (Value === undefined) return { ok: true, data: { expect: [], reject: [] } }
  if (Value === null || typeof Value !== 'object' || Array.isArray(Value)) {
    return { ok: false, message: 'assertions 需为 { expect, reject }' }
  }
  const Row = Value as Record<string, unknown>
  for (const Key of Object.keys(Row)) {
    if (Key !== 'expect' && Key !== 'reject') return { ok: false, message: `assertions 含未知键: ${Key}` }
  }
  const Expect = parseAssertionList(Row.expect)
  if (!Expect.ok) return Expect
  const Reject = parseAssertionList(Row.reject)
  if (!Reject.ok) return Reject
  return { ok: true, data: { expect: Expect.data, reject: Reject.data } }
}

function parseAssertionList(Value: unknown): { ok: true; data: EvalAssertion[] } | { ok: false; message: string } {
  if (Value === undefined) return { ok: true, data: [] }
  if (!Array.isArray(Value)) return { ok: false, message: '断言的 expect / reject 需为数组' }
  if (Value.length > 50) return { ok: false, message: '单组断言最多 50 条' }
  const Out: EvalAssertion[] = []
  for (const Item of Value) {
    if (Item === null || typeof Item !== 'object' || Array.isArray(Item)) {
      return { ok: false, message: '断言条目需为 { text, regex }' }
    }
    const Row = Item as Record<string, unknown>
    for (const Key of Object.keys(Row)) {
      if (Key !== 'text' && Key !== 'regex') return { ok: false, message: `断言含未知键: ${Key}` }
    }
    const Text = nonEmptyString(Row.text)
    if (Text === null) return { ok: false, message: '断言 text 必填且为非空字符串' }
    if (Text.length > 200) return { ok: false, message: '断言 text 最长 200 字' }
    if (Row.regex !== undefined && typeof Row.regex !== 'boolean') return { ok: false, message: 'regex 需为布尔值' }
    const Regex = Row.regex === true
    if (Regex) {
      try {
        new RegExp(Text)
      } catch {
        return { ok: false, message: `正则无法编译: ${Text}` }
      }
    }
    Out.push({ text: Text, regex: Regex })
  }
  return { ok: true, data: Out }
}

function parseCaseCreate(Body: Record<string, unknown>): { ok: true; data: EvalCaseInput } | { ok: false; message: string } {
  const Level = nonEmptyString(Body.level)
  if (Level === null) return { ok: false, message: 'level 必填且为非空字符串' }
  const Query = nonEmptyString(Body.query)
  if (Query === null) return { ok: false, message: 'query 必填且为非空字符串' }
  if (Body.negative !== undefined && typeof Body.negative !== 'boolean') return { ok: false, message: 'negative 需为布尔值' }
  const Negative = Body.negative === true
  if (Body.note !== undefined && typeof Body.note !== 'string') return { ok: false, message: 'note 需为字符串' }
  const Gold = parseGold(Body.gold === undefined ? [] : Body.gold)
  if (Gold === null) return { ok: false, message: 'gold 需为 [{data_uri, chunk_index, content_prefix}] 数组' }
  if (Negative && Gold.length > 0) return { ok: false, message: '负例的 gold 必须为空数组' }
  const Assertions = parseAssertions(Body.assertions)
  if (!Assertions.ok) return { ok: false, message: Assertions.message }
  let CaseKey: string | undefined
  if (Body.case_key !== undefined) {
    const Key = nonEmptyString(Body.case_key)
    if (Key === null) return { ok: false, message: 'case_key 需为非空字符串' }
    CaseKey = Key
  }
  const Data: EvalCaseInput = { level: Level, query: Query, negative: Negative, note: typeof Body.note === 'string' ? Body.note : '', gold: Gold, assertions: Assertions.data }
  if (CaseKey !== undefined) Data.case_key = CaseKey
  return { ok: true, data: Data }
}

function mergeCase(Existing: EvalCase, Body: Record<string, unknown>): { ok: true; data: Omit<EvalCaseInput, 'case_key'> } | { ok: false; message: string } {
  const Level = Body.level === undefined ? Existing.level : nonEmptyString(Body.level)
  if (Level === null) return { ok: false, message: 'level 必填且为非空字符串' }
  const Query = Body.query === undefined ? Existing.query : nonEmptyString(Body.query)
  if (Query === null) return { ok: false, message: 'query 必填且为非空字符串' }
  if (Body.negative !== undefined && typeof Body.negative !== 'boolean') return { ok: false, message: 'negative 需为布尔值' }
  const Negative = Body.negative === undefined ? Existing.negative : Body.negative === true
  if (Body.note !== undefined && typeof Body.note !== 'string') return { ok: false, message: 'note 需为字符串' }
  const Note = Body.note === undefined ? Existing.note : Body.note as string
  const Gold = Body.gold === undefined ? Existing.gold : parseGold(Body.gold)
  if (Gold === null) return { ok: false, message: 'gold 需为 [{data_uri, chunk_index, content_prefix}] 数组' }
  if (Negative && Gold.length > 0) return { ok: false, message: '负例的 gold 必须为空数组' }
  const Assertions = Body.assertions === undefined ? { ok: true as const, data: Existing.assertions } : parseAssertions(Body.assertions)
  if (!Assertions.ok) return { ok: false, message: Assertions.message }
  if (Body.case_key !== undefined) return { ok: false, message: 'case_key 不可修改' }
  return { ok: true, data: { level: Level, query: Query, negative: Negative, note: Note, gold: Gold, assertions: Assertions.data } }
}

function parseConfig(Kind: EvalConfigKind, Value: unknown, Models: Set<string>): { ok: true; config: Record<string, unknown> } | { ok: false; message: string } {
  if (Value === null || typeof Value !== 'object' || Array.isArray(Value)) return { ok: false, message: 'config 需为对象' }
  const Config = Value as Record<string, unknown>
  const Allowed = Kind === 'run' ? RUN_CONFIG_KEYS : METRIC_CONFIG_KEYS
  for (const Key of Object.keys(Config)) {
    if (!Allowed.includes(Key)) return { ok: false, message: `config 含未知键: ${Key}` }
  }
  for (const Key of Allowed) {
    if (!Object.hasOwn(Config, Key)) return { ok: false, message: `config 缺少键: ${Key}` }
  }

  if (Kind === 'run') {
    if (typeof Config.model !== 'string' || !Models.has(Config.model)) return { ok: false, message: 'model 必须是 /models 在册的键' }
    if (typeof Config.temperature !== 'number' || !Number.isFinite(Config.temperature) || Config.temperature < 0 || Config.temperature > 2) {
      return { ok: false, message: 'temperature 需在 0..2' }
    }
    return { ok: true, config: Config }
  }

  if (Config.judge_model !== null && (typeof Config.judge_model !== 'string' || !Models.has(Config.judge_model))) {
    return { ok: false, message: 'judge_model 需为 null 或 /models 在册的键' }
  }
  if (Config.rubric !== null) {
    if (typeof Config.rubric !== 'string' || Config.rubric.trim() === '' || resolveRubric(Config.rubric) === null) {
      return { ok: false, message: 'rubric 需为 null 或已登记的内置版本' }
    }
  }
  if (!Array.isArray(Config.metrics) || Config.metrics.length === 0) return { ok: false, message: 'metrics 需为非空字符串数组' }
  if (Config.metrics.some((Item) => typeof Item !== 'string' || Item.trim() === '')) {
    return { ok: false, message: 'metrics 需为非空字符串数组' }
  }
  return { ok: true, config: Config }
}

function parseHumanScore(Value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (Value === undefined || Value === null) return { ok: true, value: null }
  if (typeof Value !== 'number' || !Number.isInteger(Value) || Value < 0 || Value > 2) return { ok: false }
  return { ok: true, value: Value }
}
