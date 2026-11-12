/**
 * /config/retrieval —— 检索管线定义的读取、整图替换与试检索；裸 Hono，不进 hono-crud。
 * PUT 与 /validate 都先过装配探针（组件自己 parse config）：坏结构 / 坏边 / 坏参数在写库前被挡。
 * PUT 成功写库（version+1）后 reload，返回 reload_ok 与 generation；reload 失败保留旧快照。
 * /test 按 pipeline_id（默认 default）指名跑当前管线，可带 draft 做 A/B：同一 query、同一模型只 embed 一次（两侧都有嵌入节点时），
 *   不写 trace_stages（Noop 脱敏 sink 之外无旁路）。请求体不进 traces.payloads（/config 前缀已豁免）。
 */

export { ConfigRetrievalRoute }

import 'reflect-metadata'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { inject, injectable } from 'tsyringe'
import { z } from 'zod'
import { PostgresPipelineRepo, PostgresRepo, RETRIEVAL_COMPONENTS, RuntimeRetrievalRegistry } from '../adapter/contract'
import { RuntimeModelRegistry } from '../adapter/model/runtime-registry'
import { PipelineError, assemblePipeline, executePipeline } from '../retrieve/pipeline/pipeline'
import { RetrieverError } from '../retrieve/contracts'
import { embedText } from '../retrieve/pipeline/components/shared'
import { NoopStageSink } from '../trace/systemtrace/stage'
import { logError } from '../trace/systemtrace/log'

import type { Repo } from '../adapter/contract'
import type { RetrievalResult, RetrievedChunk } from '../retrieve/contracts'
import type { ComponentDef, PipelineDef, PipelineNode } from '../retrieve/pipeline/pipeline'

@injectable()
class ConfigRetrievalRoute {
  private readonly registry: RuntimeRetrievalRegistry
  private readonly pipelineRepo: PostgresPipelineRepo
  private readonly probeRepo: Repo
  private readonly models: RuntimeModelRegistry

  constructor(
    @inject(RuntimeRetrievalRegistry) Registry: RuntimeRetrievalRegistry,
    @inject(PostgresPipelineRepo) PipelineRepo: PostgresPipelineRepo,
    @inject(PostgresRepo) Repo: Repo,
    @inject(RuntimeModelRegistry) Models: RuntimeModelRegistry,
  ) {
    this.registry = Registry
    this.pipelineRepo = PipelineRepo
    this.probeRepo = Repo
    this.models = Models
  }

  build(): Hono {
    const app = new Hono()

    app.get('/', async (c) => {
      const PipelineId = c.req.query('pipeline_id')
      if (PipelineId === undefined || PipelineId === 'default') {
        try {
          const Snap = this.registry.current()
          const Status = this.registry.status()
          return c.json({
            pipeline_id: 'default',
            current: true,
            pipeline: { nodes: Snap.pipeline.nodes, output_node: Snap.pipeline.output ?? null },
            version: Snap.version,
            generation: Status.generation,
            loaded_at: Snap.loaded_at,
            last_reload: Status.last_reload,
          })
        } catch {
          return c.json({ code: 'E_RETRIEVAL_NOT_LOADED', message: '检索管线尚未装载' }, 503)
        }
      }
      const Row = await this.pipelineRepo.readById(PipelineId)
      if (Row === null) {
        return c.json({ code: 'E_PIPELINE_NOT_FOUND', message: `管线不存在: ${PipelineId}` }, 404)
      }
      return c.json({
        pipeline_id: Row.id,
        current: false,
        pipeline: { nodes: Row.nodes, output_node: Row.output_node },
        version: Row.version,
        generation: null,
        loaded_at: null,
        last_reload: null,
      })
    })

    app.get('/defs', async (c) => c.json({ pipelines: await this.pipelineRepo.listPipelines() }))

    app.put('/', async (c) => {
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
      const PipelineId = Body.pipeline_id === undefined ? 'default' : Body.pipeline_id
      if (typeof PipelineId !== 'string' || PipelineId.trim() === '') {
        return bad(c, 'E_BAD_PIPELINE_ID', 'pipeline_id 需为非空字符串')
      }
      const Id = PipelineId.trim()
      const Parsed = readPipelineDef(Body)
      if (!Parsed.ok) return bad(c, 'E_BAD_BODY', Parsed.message)
      try {
        this.probe(Parsed.value)
      } catch (Err) {
        return probeError(c, Err)
      }

      const Saved = await this.pipelineRepo.replaceById(Id, Parsed.value.nodes, Parsed.value.output ?? null)
      if (Saved === null) {
        return c.json({ code: 'E_PIPELINE_NOT_FOUND', message: `管线不存在: ${Id}` }, 404)
      }
      if (Id !== 'default') {
        return c.json({ reload_ok: true, version: Saved.version, generation: null })
      }
      const Reloaded = await this.registry.reload()
      let Generation: number | null = null
      try {
        Generation = this.registry.status().generation
      } catch {
        Generation = null
      }
      return c.json({
        reload_ok: Reloaded.ok,
        ...(Reloaded.error_code === null ? {} : { reload_error: Reloaded.error_code }),
        version: Saved.version,
        generation: Generation,
      })
    })

    app.get('/components', (c) => c.json({ components: componentsView() }))

    app.post('/validate', async (c) => {
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
      const Parsed = readPipelineDef(Body)
      if (!Parsed.ok) return bad(c, 'E_BAD_BODY', Parsed.message)
      try {
        this.probe(Parsed.value)
        return c.json({ ok: true })
      } catch (Err) {
        if (Err instanceof PipelineError) {
          return c.json({
            ok: false,
            errors: [{
              node: Err.detail.node ?? null,
              port: Err.detail.port ?? null,
              path: Err.detail.path ?? null,
              reason: Err.message,
            }],
          })
        }
        logError('E_RETRIEVAL_VALIDATE', String(Err))
        return c.json({ code: 'E_RETRIEVAL_VALIDATE', message: '管线校验失败' }, 500)
      }
    })

    app.post('/test', async (c) => {
      const Body = await readObject(c)
      if (Body === null) return bad(c, 'E_BAD_JSON', '请求体需为 JSON 对象')
      const Query = typeof Body.query === 'string' ? Body.query.trim() : ''
      if (Query === '') return bad(c, 'E_BAD_QUERY', 'query 必填')
      const PipelineId = Body.pipeline_id === undefined ? 'default' : Body.pipeline_id
      if (typeof PipelineId !== 'string' || PipelineId.trim() === '') {
        return bad(c, 'E_BAD_PIPELINE_ID', 'pipeline_id 需为非空字符串')
      }
      let Draft: PipelineDef | undefined
      if (Body.draft !== undefined) {
        if (Body.draft === null || typeof Body.draft !== 'object' || Array.isArray(Body.draft)) {
          return bad(c, 'E_BAD_DRAFT', 'draft 需为对象')
        }
        const Parsed = readPipelineDef(Body.draft as Record<string, unknown>)
        if (!Parsed.ok) return bad(c, 'E_BAD_DRAFT', Parsed.message)
        Draft = Parsed.value
      }

      const Row = await this.pipelineRepo.readById(PipelineId.trim())
      if (Row === null) {
        return c.json({ code: 'E_PIPELINE_NOT_FOUND', message: `管线不存在: ${PipelineId.trim()}` }, 404)
      }
      if (Row.output_node === null) return bad(c, 'E_PIPELINE_INVALID', '管线缺少输出节点')
      const Named: PipelineDef = { nodes: Row.nodes, output: Row.output_node }

      let Precomputed: { text: string; vector: number[]; model_key: string } | undefined
      if (Draft !== undefined && hasEmbed(Named) && hasEmbed(Draft)) {
        try {
          const Snapshot = this.models.requireEmbeddingDefault()
          Precomputed = { text: Query, model_key: Snapshot.key, vector: await embedText(Snapshot, Query, false) }
        } catch {
          /* 缺嵌入模型时不共享：两侧各自按自己的路径报错 */
          Precomputed = undefined
        }
      }

      const [Current, DraftSide] = await Promise.all([
        runSide(Named, Query, Precomputed, this.probeRepo, this.models),
        Draft === undefined ? Promise.resolve(null) : runSide(Draft, Query, Precomputed, this.probeRepo, this.models),
      ])
      return c.json({
        pipeline_id: PipelineId.trim(),
        current: Current,
        draft: DraftSide,
        embed_shared: Precomputed !== undefined,
      })
    })

    return app
  }

  private probe(Def: PipelineDef): void {
    assemblePipeline(Def, RETRIEVAL_COMPONENTS, {
      repo: this.probeRepo,
      registry: this.models,
      sink: NoopStageSink,
    })
  }
}

function componentsView() {
  return [...RETRIEVAL_COMPONENTS.values()].map((Def: ComponentDef) => ({
    name: Def.name,
    description: Def.description ?? '',
    input: z.toJSONSchema(Def.input, { io: 'input' }),
    output: z.toJSONSchema(Def.output),
    config: Def.config === undefined ? null : z.toJSONSchema(Def.config),
  }))
}

function probeError(c: Context, Err: unknown) {
  if (Err instanceof PipelineError) {
    return c.json({ code: Err.code, message: Err.message, detail: Err.detail }, 400)
  }
  logError('E_RETRIEVAL_VALIDATE', String(Err))
  return c.json({ code: 'E_RETRIEVAL_VALIDATE', message: '管线校验失败' }, 500)
}

function hasEmbed(Def: PipelineDef): boolean {
  return Def.nodes.some((Node) => Node.component === 'embed_query')
}

async function runSide(
  Def: PipelineDef,
  Query: string,
  Precomputed: { text: string; vector: number[]; model_key: string } | undefined,
  Repo: Repo,
  Models: RuntimeModelRegistry,
) {
  const Started = Date.now()
  try {
    const Run = await executePipeline(
      Def,
      RETRIEVAL_COMPONENTS,
      { repo: Repo, registry: Models, sink: NoopStageSink },
      { query: Query, ...(Precomputed === undefined ? {} : { embedding: Precomputed }) },
    )
    if (Run.output === null) throw new PipelineError('E_PIPELINE_INVALID', '管线缺少输出节点', {})
    const Output = Run.output as unknown as RetrievalResult
    return {
      hits: toHits(Output.hits),
      vectorCount: Output.vectorCount,
      lexicalCount: Output.lexicalCount,
      duration_ms: Date.now() - Started,
      error: null,
    }
  } catch (Err) {
    const Code = Err instanceof PipelineError || Err instanceof RetrieverError ? Err.code : 'E_RETRIEVAL_TEST'
    return {
      hits: [],
      vectorCount: 0,
      lexicalCount: 0,
      duration_ms: Date.now() - Started,
      error: { code: Code, message: Err instanceof Error ? Err.message : String(Err) } as { code: string; message: string } | null,
    }
  }
}

function toHits(Hits: RetrievedChunk[]) {
  return Hits.map((Hit) => ({
    chunkId: Hit.chunk.id,
    resourceId: Hit.chunk.resource_id,
    chunkIndex: Hit.chunk.chunk_index,
    startOffset: Hit.chunk.start_offset,
    endOffset: Hit.chunk.end_offset,
    docTitle: Hit.docTitle,
    source: Hit.source,
    dataUri: Hit.dataUri,
    score: Hit.score,
    similarity: Hit.similarity,
    lexicalScore: Hit.lexicalScore,
    content: Hit.chunk.content,
  }))
}

function readObject(c: Context): Promise<Record<string, unknown> | null> {
  return c.req.json().catch(() => null).then((Body) => {
    if (Body === null || typeof Body !== 'object' || Array.isArray(Body)) return null
    return Body as Record<string, unknown>
  })
}

function readPipelineDef(Body: Record<string, unknown>): { ok: true; value: PipelineDef } | { ok: false; message: string } {
  if (!Array.isArray(Body.nodes) || Body.nodes.length === 0) return { ok: false, message: 'nodes 需为非空数组' }
  if (Body.nodes.some((Item) => Item === null || typeof Item !== 'object' || Array.isArray(Item))) {
    return { ok: false, message: 'nodes 每项需为对象' }
  }
  if (typeof Body.output_node !== 'string' || Body.output_node.trim() === '') {
    return { ok: false, message: 'output_node 必填' }
  }
  return { ok: true, value: { nodes: Body.nodes as PipelineNode[], output: Body.output_node } }
}

function bad(c: Context, Code: string, Message: string) {
  return c.json({ code: Code, message: Message }, 400)
}
