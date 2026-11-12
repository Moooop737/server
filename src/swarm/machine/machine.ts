/**
 * machine 装配 —— 把一张 swarm 图装成可执行 plan：结构 → 节点配置 → 入口 / 输出 → 模型 / 管线 / KB → worker 工具。
 * 不调用模型、不执行图、不写库；只读 registry 快照、pipeline_defs 与图定义。
 * 预检出口 assembleMachine 只投影 plan；编译出口 compileMachine 额外交出单 worker 的模型 / instructions / 工具 / 步预算。
 * v1 入口支持 worker 或触发器 connector、单 KB；外部能力 connector 报未实现；编译只接受单 worker。
 */

export { assembleMachine, compileMachine }
export type {
  MachineAssembleInput, MachineDeps, MachinePlan, MachineNodePlan, MachineWorkerPlan,
  MachineRetrieverPlan, MachineKbPlan, MachineConnectorPlan, MachineEdgePlan, MachineIssue, MachinePreflightResult,
  MachineWorkerRuntime, CompiledMachine, MachineCompileResult,
}

import { PipelineError, assemblePipeline } from '../../retrieve/pipeline/pipeline'
import { RETRIEVAL_COMPONENTS, assembleRetriever } from '../../adapter/retrieve/default'
import { NoopStageSink } from '../../trace/systemtrace/stage'
import { RuntimeRegistryError } from '../../adapter/model/runtime-registry'
import { retrieve } from '../../agent/tool/tools/retrieve'
import { weaveAgentTools } from '../../agent/tool/weave'
import { SwarmError, validateSwarmGraph } from '../graph'
import { validateNodeConfigs } from './nodes'
import { WORKER_DEFAULT_STEP_LIMIT } from './nodes/worker'

import type { LanguageModelV4 } from '@ai-sdk/provider'
import type { ToolSet } from 'ai'
import type { RuntimeModelRegistry } from '../../adapter/model/runtime-registry'
import type { PostgresPipelineRepo, PipelineRow } from '../../adapter/repo/pipeline'
import type { Repo } from '../../adapter/contract'
import type { PipelineDef, PipelineNode } from '../../retrieve/pipeline/pipeline'
import type { Retriever } from '../../retrieve/contracts'
import type { AgentToolEntry } from '../../agent/tool/weave'
import type { SwarmEdge, SwarmGraphDef, SwarmNode } from '../graph'
import type { WorkerConfig } from './nodes/worker'
import type { RetrieverConfig } from './nodes/retriever'
import type { KbConfig } from './nodes/kb'
import type { ConnectorConfig } from './nodes/connector'

interface MachineAssembleInput {
  swarm_id: string
  swarm_version: number | null
  graph: SwarmGraphDef
}

interface MachineDeps {
  registry: RuntimeModelRegistry
  pipelines: Pick<PostgresPipelineRepo, 'readById'>
  repo: Repo
}

interface MachineWorkerPlan {
  id: string
  kind: 'worker'
  model_key: string
  prompt: string
  step_limit: number
  tools: string[]
}

interface MachineRetrieverPlan {
  id: string
  kind: 'retriever'
  pipeline_id: string
  pipeline_version: number
  bindings: string[]
}

interface MachineKbPlan {
  id: string
  kind: 'kb'
  label: string | null
  embedding_model: string
  dimensions: number
}

interface MachineConnectorPlan {
  id: string
  kind: 'connector'
  connector_kind: string
  role: 'trigger'
}

type MachineNodePlan = MachineWorkerPlan | MachineRetrieverPlan | MachineKbPlan | MachineConnectorPlan

interface MachineEdgePlan {
  id: string
  from: { node: string; port: string }
  to: { node: string; port: string }
  purpose: 'tool' | 'binding' | 'external'
}

interface MachinePlan {
  swarm_id: string
  swarm_version: number | null
  entry: string
  output: string
  nodes: MachineNodePlan[]
  edges: MachineEdgePlan[]
}

interface MachineIssue {
  code: string
  node: string | null
  edge: string | null
  port: string | null
  field: string | null
  reason: string
}

type MachinePreflightResult = { ok: true; plan: MachinePlan } | { ok: false; errors: MachineIssue[] }

interface MachineWorkerRuntime {
  id: string
  model: LanguageModelV4
  model_key: string
  instructions: string
  tools: ToolSet
  step_limit: number
  prompt: string
}

interface CompiledMachine {
  plan: MachinePlan
  worker: MachineWorkerRuntime
}

type MachineCompileResult = { ok: true; compiled: CompiledMachine } | { ok: false; errors: MachineIssue[] }

type MachineInternalResult =
  | { ok: true; plan: MachinePlan; workers: Map<string, MachineWorkerRuntime> }
  | { ok: false; errors: MachineIssue[] }

async function assembleMachineInternal(Input: MachineAssembleInput, Deps: MachineDeps): Promise<MachineInternalResult> {
  try {
    validateSwarmGraph(Input.graph)
  } catch (Err) {
    if (Err instanceof SwarmError) {
      return { ok: false, errors: [swarmIssue(Err)] }
    }
    throw Err
  }

  const ConfigIssues = validateNodeConfigs(Input.graph.nodes)
  if (ConfigIssues.length > 0) {
    return {
      ok: false,
      errors: ConfigIssues.map((Issue) => issue('E_MACHINE_NODE_CONFIG', Issue.node, null, null, Issue.field, Issue.reason)),
    }
  }

  const Issues: MachineIssue[] = []
  const Nodes = new Map(Input.graph.nodes.map((Node) => [Node.id, Node]))
  const Inbound = new Map<string, number>()
  const Outbound = new Map<string, SwarmEdge[]>()
  for (const Node of Input.graph.nodes) {
    Inbound.set(Node.id, 0)
    Outbound.set(Node.id, [])
  }
  for (const Edge of Input.graph.edges) {
    Inbound.set(Edge.to.node, (Inbound.get(Edge.to.node) ?? 0) + 1)
    Outbound.get(Edge.from.node)!.push(Edge)
  }

  const Roots = Input.graph.nodes.filter((Node) => (Inbound.get(Node.id) ?? 0) === 0)
  let Entry: SwarmNode | null = null
  if (Roots.length !== 1) {
    Issues.push(issue(
      'E_MACHINE_ENTRY', null, null, null, null,
      Roots.length === 0 ? '图没有入口节点' : `入口不唯一: ${Roots.map((Node) => Node.id).join(', ')}`,
    ))
  } else {
    const Root = Roots[0]!
    if (Root.kind === 'worker') {
      Entry = Root
    } else if (Root.kind === 'connector') {
      const ToWorker = (Outbound.get(Root.id) ?? []).some((Edge) => Nodes.get(Edge.to.node)?.kind === 'worker')
      if (ToWorker) {
        Entry = Root
      } else {
        Issues.push(issue('E_MACHINE_ENTRY', Root.id, null, null, null, '触发器 connector 缺少下游 worker'))
      }
    } else {
      Issues.push(issue('E_MACHINE_ENTRY', Root.id, null, null, null, `入口须为 worker 或触发器 connector: ${Root.kind}`))
    }
  }

  const OutputNode = Nodes.get(Input.graph.output)
  if (OutputNode === undefined) {
    Issues.push(issue('E_MACHINE_OUTPUT', Input.graph.output, null, null, null, '输出节点不存在'))
  } else if (OutputNode.kind !== 'worker') {
    Issues.push(issue('E_MACHINE_OUTPUT', OutputNode.id, null, null, null, `输出须为 worker: ${OutputNode.kind}`))
  }

  const KbNodes = Input.graph.nodes.filter((Node) => Node.kind === 'kb')
  if (KbNodes.length > 1) {
    Issues.push(issue('E_MACHINE_KB_BINDING', KbNodes[1]!.id, null, null, 'kb', 'v1 只支持单 KB'))
  }

  let Embedding: { key: string; dimensions: number } | null = null
  if (KbNodes.length > 0) {
    try {
      const Default = defaultEmbeddingOf(Deps.registry)
      if (Default.ok) {
        Embedding = Default.embedding
      } else {
        for (const Kb of KbNodes) {
          Issues.push(issue('E_MACHINE_EMBEDDING_MISSING', Kb.id, null, null, 'embedding_model', Default.error))
        }
      }
    } catch (Err) {
      if (Err instanceof RuntimeRegistryError) {
        for (const Kb of KbNodes) {
          Issues.push(issue('E_MACHINE_EMBEDDING_MISSING', Kb.id, null, null, 'embedding_model', Err.message))
        }
      } else {
        throw Err
      }
    }
  }

  const RetrieverPlans = new Map<string, MachineRetrieverPlan>()
  const RetrieverHandles = new Map<string, Retriever>()
  for (const Node of Input.graph.nodes) {
    if (Node.kind !== 'retriever') continue
    const Config = (Node.config ?? {}) as RetrieverConfig
    const BindingEdges = (Outbound.get(Node.id) ?? []).filter((Edge) => Nodes.get(Edge.to.node)?.kind === 'kb')
    if (BindingEdges.length === 0) {
      Issues.push(issue('E_MACHINE_KB_BINDING', Node.id, null, null, 'kb', 'retriever 未绑定 KB'))
      continue
    }
    if (BindingEdges.length > 1) {
      Issues.push(issue('E_MACHINE_KB_BINDING', Node.id, null, null, 'kb', 'v1 只支持单 KB 绑定'))
      continue
    }

    const PipelineId = Config.pipeline_id ?? 'default'
    const Row = await Deps.pipelines.readById(PipelineId)
    if (Row === null) {
      Issues.push(issue('E_MACHINE_PIPELINE_NOT_FOUND', Node.id, null, null, 'pipeline_id', `管线不存在: ${PipelineId}`))
      continue
    }
    if (Row.output_node === null) {
      Issues.push(issue('E_MACHINE_PIPELINE_INVALID', Node.id, null, null, 'pipeline_id', `管线缺少输出节点: ${PipelineId}`))
      continue
    }

    const Def: PipelineDef = { nodes: Row.nodes, output: Row.output_node }
    try {
      assemblePipeline(Def, RETRIEVAL_COMPONENTS, { repo: Deps.repo, registry: Deps.registry, sink: NoopStageSink })
    } catch (Err) {
      if (Err instanceof PipelineError) {
        Issues.push(issue('E_MACHINE_PIPELINE_INVALID', Node.id, null, null, 'pipeline_id', `${Err.code}: ${Err.message}`))
        continue
      }
      throw Err
    }

    const PinIssues = pinIssuesOf(Node.id, Row.nodes, Deps.registry)
    if (PinIssues.length > 0) {
      Issues.push(...PinIssues)
      continue
    }

    RetrieverHandles.set(Node.id, assembleRetriever(Def, RETRIEVAL_COMPONENTS, { repo: Deps.repo, registry: Deps.registry }))
    RetrieverPlans.set(Node.id, {
      id: Node.id,
      kind: 'retriever',
      pipeline_id: PipelineId,
      pipeline_version: Row.version,
      bindings: BindingEdges.map((Edge) => Edge.to.node),
    })
  }

  for (const Node of Input.graph.nodes) {
    if (Node.kind !== 'connector') continue
    /* 无入边的 connector 是触发器候选，入口检查已负责；有入边的才是 worker→connector 外部能力 */
    if ((Inbound.get(Node.id) ?? 0) === 0) continue
    const Config = (Node.config ?? {}) as ConnectorConfig
    Issues.push(issue('E_MACHINE_CONNECTOR_UNKNOWN', Node.id, null, null, 'kind', `外部能力连接器未实现: ${Config.kind}`))
  }

  const WorkerPlans = new Map<string, MachineWorkerPlan>()
  const WorkerRuntimes = new Map<string, MachineWorkerRuntime>()
  for (const Node of Input.graph.nodes) {
    if (Node.kind !== 'worker') continue
    const Config = (Node.config ?? {}) as WorkerConfig
    let Model: LanguageModelV4 | undefined
    try {
      Model = Deps.registry.resolve(Config.model_key)
    } catch (Err) {
      if (Err instanceof RuntimeRegistryError) {
        Issues.push(issue(Err.code, Node.id, null, null, 'model_key', Err.message))
        continue
      }
      throw Err
    }
    if (Model === undefined) {
      Issues.push(issue('E_MACHINE_MODEL_UNKNOWN', Node.id, null, null, 'model_key', `模型不在册: ${Config.model_key}`))
      continue
    }

    const Out = Outbound.get(Node.id) ?? []
    const RetrieverEdges = Out.filter((Edge) => Nodes.get(Edge.to.node)?.kind === 'retriever')
    if (RetrieverEdges.length > 1) {
      Issues.push(issue('E_MACHINE_WORKER_TOOL', Node.id, null, null, 'edges', 'v1 每个 worker 至多绑定一个 retriever'))
      continue
    }

    const Entries: AgentToolEntry[] = []
    let Broken = false
    for (const Edge of RetrieverEdges) {
      const Handle = RetrieverHandles.get(Edge.to.node)
      if (Handle === undefined) {
        Broken = true
        break
      }
      Entries.push(retrieve(Handle))
    }
    if (Broken) continue
    if (Out.some((Edge) => Nodes.get(Edge.to.node)?.kind === 'connector')) continue

    let Woven: ReturnType<typeof weaveAgentTools>
    try {
      Woven = weaveAgentTools(Entries, Config.prompt)
    } catch (Err) {
      Issues.push(issue('E_MACHINE_WORKER_TOOL', Node.id, null, null, 'edges', `工具装配失败: ${messageOf(Err)}`))
      continue
    }
    const StepLimit = Config.step_limit ?? WORKER_DEFAULT_STEP_LIMIT
    WorkerPlans.set(Node.id, {
      id: Node.id,
      kind: 'worker',
      model_key: Config.model_key,
      prompt: Config.prompt,
      step_limit: StepLimit,
      tools: Entries.map((Entry) => Entry.name),
    })
    WorkerRuntimes.set(Node.id, {
      id: Node.id,
      model: Model,
      model_key: Config.model_key,
      instructions: Woven.instructions,
      tools: Woven.tools,
      step_limit: StepLimit,
      prompt: Config.prompt,
    })
  }

  if (Issues.length > 0) return { ok: false, errors: Issues }
  if (Entry === null || OutputNode === undefined || (Embedding === null && KbNodes.length > 0)) {
    return { ok: false, errors: [issue('E_MACHINE_PREFLIGHT', null, null, null, null, '装配结果不完整')] }
  }

  const PlanNodes: MachineNodePlan[] = []
  for (const Node of Input.graph.nodes) {
    if (Node.kind === 'worker') {
      const Plan = WorkerPlans.get(Node.id)
      if (Plan !== undefined) PlanNodes.push(Plan)
    } else if (Node.kind === 'retriever') {
      const Plan = RetrieverPlans.get(Node.id)
      if (Plan !== undefined) PlanNodes.push(Plan)
    } else if (Node.kind === 'kb' && Embedding !== null) {
      const Config = (Node.config ?? {}) as KbConfig
      PlanNodes.push({
        id: Node.id,
        kind: 'kb',
        label: Config.label ?? null,
        embedding_model: Embedding.key,
        dimensions: Embedding.dimensions,
      })
    } else if (Node.kind === 'connector' && Entry !== null && Entry.id === Node.id) {
      const Config = (Node.config ?? {}) as ConnectorConfig
      PlanNodes.push({ id: Node.id, kind: 'connector', connector_kind: Config.kind, role: 'trigger' })
    }
  }

  return {
    ok: true,
    plan: {
      swarm_id: Input.swarm_id,
      swarm_version: Input.swarm_version,
      entry: Entry.id,
      output: OutputNode.id,
      nodes: PlanNodes,
      edges: Input.graph.edges.map((Edge) => ({
        id: Edge.id,
        from: Edge.from,
        to: Edge.to,
        purpose: purposeOf(Edge, Nodes),
      })),
    },
    workers: WorkerRuntimes,
  }
}

async function assembleMachine(Input: MachineAssembleInput, Deps: MachineDeps): Promise<MachinePreflightResult> {
  const Result = await assembleMachineInternal(Input, Deps)
  return Result.ok ? { ok: true, plan: Result.plan } : Result
}

async function compileMachine(Input: MachineAssembleInput, Deps: MachineDeps): Promise<MachineCompileResult> {
  const Result = await assembleMachineInternal(Input, Deps)
  if (!Result.ok) return Result

  const Workers = [...Result.workers.values()]
  if (Workers.length !== 1) {
    return {
      ok: false,
      errors: [issue('E_MACHINE_RUN_SHAPE', null, null, null, null, 'v1 运行只支持单 worker')],
    }
  }
  const Worker = Workers[0]!
  if (Result.plan.output !== Worker.id) {
    return {
      ok: false,
      errors: [issue('E_MACHINE_RUN_SHAPE', Worker.id, null, null, null, '输出必须是唯一的 worker')],
    }
  }
  return { ok: true, compiled: { plan: Result.plan, worker: Worker } }
}

function defaultEmbeddingOf(Registry: RuntimeModelRegistry): { ok: true; embedding: { key: string; dimensions: number } } | { ok: false; error: string } {
  const Default = Registry.embeddingDefault()
  if (Default === null) return { ok: false, error: '未配置可用的默认嵌入模型' }
  if (!Default.available || Default.model === null) return { ok: false, error: `嵌入模型不可用: ${Default.key}` }
  if (Default.dimensions === null) return { ok: false, error: `嵌入模型缺少 dimensions: ${Default.key}` }
  return { ok: true, embedding: { key: Default.key, dimensions: Default.dimensions } }
}

function pinIssuesOf(NodeId: string, Nodes: PipelineNode[], Registry: RuntimeModelRegistry): MachineIssue[] {
  const Pins = new Set<string>()
  for (const Node of Nodes) {
    if (Node.component !== 'embed_query') continue
    if (Node.config === null || typeof Node.config !== 'object' || Array.isArray(Node.config)) continue
    const Model = (Node.config as { model?: unknown }).model
    if (typeof Model === 'string' && Model.trim() !== '') Pins.add(Model.trim())
  }

  const Issues: MachineIssue[] = []
  for (const Pin of Pins) {
    try {
      Registry.requireEmbedding(Pin)
    } catch (Err) {
      if (Err instanceof RuntimeRegistryError) {
        Issues.push(issue('E_MACHINE_EMBEDDING_MISSING', NodeId, null, null, 'embedding_model', Err.message))
      } else {
        throw Err
      }
    }
  }
  return Issues
}

function purposeOf(Edge: SwarmEdge, Nodes: Map<string, SwarmNode>): MachineEdgePlan['purpose'] {
  const From = Nodes.get(Edge.from.node)?.kind
  const To = Nodes.get(Edge.to.node)?.kind
  if (From === 'worker' && To === 'retriever') return 'tool'
  if (From === 'retriever' && To === 'kb') return 'binding'
  return 'external'
}

function swarmIssue(Err: SwarmError): MachineIssue {
  return {
    code: Err.code,
    node: Err.detail.node ?? null,
    edge: Err.detail.edge ?? null,
    port: Err.detail.port ?? null,
    field: null,
    reason: Err.message,
  }
}

function issue(
  Code: string,
  Node: string | null,
  Edge: string | null,
  Port: string | null,
  Field: string | null,
  Reason: string,
): MachineIssue {
  return { code: Code, node: Node, edge: Edge, port: Port, field: Field, reason: Reason }
}

function messageOf(Err: unknown): string {
  return Err instanceof Error ? Err.message : String(Err)
}
