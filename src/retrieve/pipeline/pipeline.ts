/**
 * 检索管线执行器 —— 节点 + 具名端口边。装配期按 isSubschema 校验每条边并构造每个节点的 stage：
 * 组件在 create 里解析自己的 config，不合格由组件抛（ZodError 统一包成 E_NODE_CONFIG），不另设校验函数。
 * 运行期按拓扑层并行，复用装配好的 stage；检索参数只认管线 config，调用方只传 query 与可选的模型身份。
 * 嵌入模型由组件在 run 里解析（端口 / 引脚默认 / 全局默认），执行器不再预取嵌入快照；
 * 纯词路管线不受影响。一个输入端口只接一条边；fan-in 靠组件多个输入端口（RRF 的 a / b）。
 * 装载 / 保存前用探针 Deps 跑一遍装配即可暴露坏结构、坏边与坏参数。
 */

export { assemblePipeline, executePipeline, PipelineError }
export type { AssemblyDeps, ComponentDef, ComponentDeps, Stage, PipelineDef, PipelineNode, PipelineRun }

import { z } from 'zod'
import { isSubschema } from './schema'
import { NoopStageSink } from '../../trace/systemtrace/stage'

import type { JsonSchema } from './schema'
import type { Repo } from '../../adapter/contract'
import type { RuntimeModelRegistry } from '../../adapter/model/runtime-registry'
import type { StageSink } from '../../trace/systemtrace/stage'

interface Stage {
  run(Input: Record<string, unknown>): Promise<unknown>
}

interface AssemblyDeps {
  repo: Repo
  registry: RuntimeModelRegistry
  sink: StageSink
  precomputed?: { text: string; vector: number[]; model_key: string } // A/B 试检索共享（同一 query、同一模型才复用）
}

interface ComponentDeps extends AssemblyDeps {
  nodeId: string
}

interface ComponentDef {
  name: string
  description?: string
  input: z.ZodType
  output: z.ZodType
  config?: z.ZodType
  create(Config: unknown, Deps: ComponentDeps): Stage
}

interface PipelineNode {
  id: string
  component: string
  config?: unknown
  inputs?: Record<string, string> // 输入端口 → 'nodeId.port'
}

interface PipelineDef {
  nodes: PipelineNode[]
  output?: string
}

interface PipelineRun {
  layers: string[][]
  outputs: Map<string, Record<string, unknown>>
  output: Record<string, unknown> | null
}

class PipelineError extends Error {
  readonly code: string
  readonly detail: Record<string, unknown>

  constructor(Code: string, Message: string, Detail: Record<string, unknown> = {}) {
    super(Message)
    this.name = 'PipelineError'
    this.code = Code
    this.detail = Detail
  }
}

interface Assembly {
  layers: string[][]
  nodes: Map<string, PipelineNode>
  components: Map<string, ComponentDef>
  stages: Map<string, Stage>
}

function assemblePipeline(Def: PipelineDef, Components: Map<string, ComponentDef>, Deps: AssemblyDeps): Assembly {
  const Nodes = new Map<string, PipelineNode>()
  for (const Node of Def.nodes) {
    if (Nodes.has(Node.id)) throw new PipelineError('E_PIPELINE_INVALID', `重复节点 id: ${Node.id}`, { node: Node.id })
    Nodes.set(Node.id, Node)
  }

  const Schemas = new Map<string, { input: JsonSchema; output: JsonSchema }>()
  for (const [Name, Component] of Components) {
    Schemas.set(Name, {
      input: z.toJSONSchema(Component.input, { io: 'input' }) as JsonSchema,
      output: z.toJSONSchema(Component.output) as JsonSchema,
    })
  }

  const Dependencies = new Map<string, Set<string>>()
  for (const Node of Def.nodes) {
    const Component = Components.get(Node.component)
    if (Component === undefined) {
      throw new PipelineError('E_PIPELINE_INVALID', `未知组件: ${Node.component}`, { node: Node.id })
    }
    const Local = new Set<string>()
    for (const [InPort, Ref] of Object.entries(Node.inputs ?? {})) {
      const Parsed = parseRef(Ref, Node.id)
      const Upstream = Nodes.get(Parsed.nodeId)
      if (Upstream === undefined) {
        throw new PipelineError('E_PIPELINE_INVALID', `边指向不存在的节点: ${Ref}`, { node: Node.id, port: InPort })
      }
      const UpComponent = Components.get(Upstream.component)!
      const Provided = propertyOf(Schemas.get(UpComponent.name)!.output, Parsed.port)
      if (Provided === undefined) {
        throw new PipelineError('E_PIPELINE_INVALID', `上游 ${Upstream.id} 没有输出端口 ${Parsed.port}`, {
          node: Node.id, port: InPort, from: Ref,
        })
      }
      const Required = propertyOf(Schemas.get(Component.name)!.input, InPort)
      if (Required === undefined) {
        throw new PipelineError('E_PIPELINE_INVALID', `组件 ${Component.name} 没有输入端口 ${InPort}`, {
          node: Node.id, port: InPort,
        })
      }
      const Verdict = isSubschema(Provided, Required, `${Node.id}.${InPort}`)
      if (!Verdict.ok) {
        throw new PipelineError(
          Verdict.unsupported ? 'E_SCHEMA_UNSUPPORTED' : 'E_PIPELINE_INVALID',
          `${Node.id}.${InPort}: ${Verdict.reason}`,
          { node: Node.id, port: InPort, path: Verdict.path, from: Ref },
        )
      }
      Local.add(Parsed.nodeId)
    }
    Dependencies.set(Node.id, Local)
  }

  const InDegree = new Map<string, number>()
  const Dependents = new Map<string, Set<string>>()
  for (const Node of Def.nodes) {
    InDegree.set(Node.id, 0)
    Dependents.set(Node.id, new Set())
  }
  for (const [Id, Upstreams] of Dependencies) {
    for (const Up of Upstreams) {
      InDegree.set(Id, (InDegree.get(Id) ?? 0) + 1)
      Dependents.get(Up)!.add(Id)
    }
  }

  const Layers: string[][] = []
  let Ready = Def.nodes.filter((Node) => InDegree.get(Node.id) === 0).map((Node) => Node.id)
  let Processed = 0
  while (Ready.length > 0) {
    Layers.push(Ready)
    Processed += Ready.length
    const Next: string[] = []
    for (const Id of Ready) {
      for (const Down of Dependents.get(Id)!) {
        const Left = (InDegree.get(Down) ?? 0) - 1
        InDegree.set(Down, Left)
        if (Left === 0) Next.push(Down)
      }
    }
    Ready = Next
  }
  if (Processed !== Def.nodes.length) {
    const Remaining = Def.nodes.filter((Node) => !Layers.flat().includes(Node.id)).map((Node) => Node.id)
    throw new PipelineError('E_PIPELINE_CYCLE', '管线存在环路', { remaining: Remaining })
  }
  if (Def.output !== undefined && !Nodes.has(Def.output)) {
    throw new PipelineError('E_PIPELINE_INVALID', `输出节点不存在: ${Def.output}`, { output: Def.output })
  }

  const Stages = new Map<string, Stage>()
  for (const Node of Def.nodes) {
    Stages.set(Node.id, buildStage(Node, Components.get(Node.component)!, Deps))
  }

  return { layers: Layers, nodes: Nodes, components: Components, stages: Stages }
}

interface ExecuteDeps {
  repo: Repo
  registry: RuntimeModelRegistry
  sink?: StageSink
}

async function executePipeline(
  Def: PipelineDef,
  Components: Map<string, ComponentDef>,
  Deps: ExecuteDeps,
  Input: {
    query: string
    model?: string
    embedding?: { text: string; vector: number[]; model_key: string }
  },
): Promise<PipelineRun> {
  const RunDeps: AssemblyDeps = {
    repo: Deps.repo,
    registry: Deps.registry,
    sink: Deps.sink ?? NoopStageSink,
    ...(Input.embedding === undefined ? {} : { precomputed: Input.embedding }),
  }
  const Assembly = assemblePipeline(Def, Components, RunDeps)
  const Outputs = new Map<string, Record<string, unknown>>()

  for (const Layer of Assembly.layers) {
    await Promise.all(Layer.map(async (Id) => {
      const Node = Assembly.nodes.get(Id)!
      const Component = Assembly.components.get(Node.component)!
      const Ports = Object.entries(Node.inputs ?? {})
      const NodeInput: Record<string, unknown> = {}
      if (Ports.length === 0) {
        Object.assign(NodeInput, Input)
      } else {
        for (const [InPort, Ref] of Ports) {
          const Parsed = parseRef(Ref, Id)
          const Upstream = Outputs.get(Parsed.nodeId)
          if (Upstream === undefined) {
            throw new PipelineError('E_PIPELINE_INVALID', `上游尚未执行: ${Ref}`, { node: Id, port: InPort })
          }
          NodeInput[InPort] = Upstream[Parsed.port]
        }
      }

      const ParsedInput = Component.input.safeParse(NodeInput)
      if (!ParsedInput.success) {
        throw new PipelineError('E_NODE_INPUT', `${Id} 输入不符合 schema: ${issuesOf(ParsedInput.error)}`, { node: Id })
      }

      const Stage = Assembly.stages.get(Id)!
      const Result = await Stage.run(ParsedInput.data as Record<string, unknown>)

      const ParsedOutput = Component.output.safeParse(Result)
      if (!ParsedOutput.success) {
        throw new PipelineError('E_NODE_OUTPUT', `${Id} 输出不符合 schema: ${issuesOf(ParsedOutput.error)}`, { node: Id })
      }
      Outputs.set(Id, ParsedOutput.data as Record<string, unknown>)
    }))
  }

  return {
    layers: Assembly.layers,
    outputs: Outputs,
    output: Def.output === undefined ? null : Outputs.get(Def.output)!,
  }
}

function buildStage(
  Node: PipelineNode,
  Component: ComponentDef,
  Deps: AssemblyDeps,
): Stage {
  const Raw = asObject(Node.config)
  try {
    return Component.create(Raw, { ...Deps, nodeId: Node.id })
  } catch (Err) {
    if (Err instanceof z.ZodError) {
      throw new PipelineError('E_NODE_CONFIG', `${Node.id} 配置不符合 schema: ${issuesOf(Err)}`, { node: Node.id })
    }
    throw Err
  }
}

function parseRef(Ref: string, NodeId: string): { nodeId: string; port: string } {
  const At = Ref.indexOf('.')
  if (At <= 0 || At === Ref.length - 1) {
    throw new PipelineError('E_PIPELINE_INVALID', `边引用需为 node.port: ${Ref}`, { node: NodeId, ref: Ref })
  }
  return { nodeId: Ref.slice(0, At), port: Ref.slice(At + 1) }
}

function propertyOf(Schema: JsonSchema, Key: string): JsonSchema | undefined {
  const Props = Schema.properties
  if (Props === null || typeof Props !== 'object' || Array.isArray(Props)) return undefined
  const Value = (Props as Record<string, unknown>)[Key]
  if (Value === null || typeof Value !== 'object' || Array.isArray(Value)) return undefined
  return Value as JsonSchema
}

function asObject(Value: unknown): Record<string, unknown> {
  if (Value === null || typeof Value !== 'object' || Array.isArray(Value)) return {}
  return Value as Record<string, unknown>
}

function issuesOf(Error: z.ZodError): string {
  return Error.issues.map((Issue) => `${Issue.path.join('.') || '$'}: ${Issue.message}`).join('; ')
}
