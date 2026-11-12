/**
 * swarm 图 —— 节点、边与结构校验。边只有一种结构、不存类型：
 * 每条边先查逻辑交换表（允许的端点对与方向），再校验两端端口结构可赋值（复用 isSubschema），最后查无环。
 * 构建期注入（worker 拿 retriever 工具、retriever 拿 KB 句柄）不在本文件；本文件只保证图能被装配与运行。
 * 端口只列请求 / 触发方向；响应（hits / chunks）随同一次调用返回，不单列反向边。
 */

export { SwarmError, validateSwarmGraph }
export type { SwarmNodeKind, SwarmNode, SwarmEdgeRef, SwarmEdge, SwarmGraphDef, SwarmGraphErrorDetail }

import { isSubschema } from '../retrieve/pipeline/schema'

import type { JsonSchema } from '../retrieve/pipeline/schema'

type SwarmNodeKind = 'worker' | 'retriever' | 'kb' | 'connector'

interface SwarmNode {
  id: string
  kind: SwarmNodeKind
  config?: Record<string, unknown>
  /* 画布坐标：随节点存 jsonb，结构校验不看这一位 */
  position?: { x: number; y: number }
}

interface SwarmEdgeRef {
  node: string
  port: string
}

interface SwarmEdge {
  id: string
  from: SwarmEdgeRef
  to: SwarmEdgeRef
}

interface SwarmGraphDef {
  nodes: SwarmNode[]
  edges: SwarmEdge[]
  output: string
}

interface SwarmGraphErrorDetail {
  node?: string
  edge?: string
  port?: string
  path?: string
  reason?: string
  remaining?: string[]
}

const NODE_KINDS: readonly SwarmNodeKind[] = ['worker', 'retriever', 'kb', 'connector']

const RELATIONS: readonly { from: SwarmNodeKind; to: SwarmNodeKind }[] = [
  { from: 'worker', to: 'retriever' },
  { from: 'retriever', to: 'kb' },
  { from: 'worker', to: 'connector' },
  { from: 'connector', to: 'worker' },
]

const PORT_SCHEMAS: Record<SwarmNodeKind, { input: Record<string, JsonSchema>; output: Record<string, JsonSchema> }> = {
  worker: {
    input: { event: { type: 'object' }, text: { type: 'string' } },
    output: { query: { type: 'string' } },
  },
  retriever: {
    input: { query: { type: 'string' } },
    output: { query: { type: 'string' } },
  },
  kb: {
    input: { query: { type: 'string' } },
    output: {},
  },
  connector: {
    input: { query: { type: 'string' } },
    output: { event: { type: 'object' }, text: { type: 'string' } },
  },
}

class SwarmError extends Error {
  readonly code: string
  readonly detail: SwarmGraphErrorDetail

  constructor(Code: string, Message: string, Detail: SwarmGraphErrorDetail = {}) {
    super(Message)
    this.name = 'SwarmError'
    this.code = Code
    this.detail = Detail
  }
}

function validateSwarmGraph(Def: SwarmGraphDef): void {
  if (!Array.isArray(Def.nodes) || Def.nodes.length === 0) {
    throw new SwarmError('E_SWARM_INVALID', 'nodes 需为非空数组', { reason: 'nodes 需为非空数组' })
  }

  const Nodes = new Map<string, SwarmNode>()
  for (const Node of Def.nodes) {
    if (Node === null || typeof Node !== 'object' || Array.isArray(Node)) {
      throw new SwarmError('E_SWARM_INVALID', '节点需为对象', { reason: '节点需为对象' })
    }
    if (typeof Node.id !== 'string' || Node.id.trim() === '') {
      throw new SwarmError('E_SWARM_INVALID', '节点 id 需为非空字符串', { reason: '节点 id 需为非空字符串' })
    }
    if (Nodes.has(Node.id)) {
      throw new SwarmError('E_SWARM_INVALID', `重复节点 id: ${Node.id}`, { node: Node.id, reason: '重复节点 id' })
    }
    if (!NODE_KINDS.includes(Node.kind)) {
      throw new SwarmError('E_SWARM_INVALID', `未知节点类型: ${String(Node.kind)}`, {
        node: Node.id, reason: `未知节点类型: ${String(Node.kind)}`,
      })
    }
    if (Node.config !== undefined && (Node.config === null || typeof Node.config !== 'object' || Array.isArray(Node.config))) {
      throw new SwarmError('E_SWARM_INVALID', `节点 config 需为对象: ${Node.id}`, { node: Node.id, reason: 'config 需为对象' })
    }
    Nodes.set(Node.id, Node)
  }

  if (!Array.isArray(Def.edges)) {
    throw new SwarmError('E_SWARM_INVALID', 'edges 需为数组', { reason: 'edges 需为数组' })
  }

  const EdgeIds = new Set<string>()
  for (const Edge of Def.edges) {
    if (Edge === null || typeof Edge !== 'object' || Array.isArray(Edge)) {
      throw new SwarmError('E_SWARM_INVALID', '边需为对象', { reason: '边需为对象' })
    }
    if (typeof Edge.id !== 'string' || Edge.id.trim() === '') {
      throw new SwarmError('E_SWARM_INVALID', '边 id 需为非空字符串', { reason: '边 id 需为非空字符串' })
    }
    if (EdgeIds.has(Edge.id)) {
      throw new SwarmError('E_SWARM_INVALID', `重复边 id: ${Edge.id}`, { edge: Edge.id, reason: '重复边 id' })
    }
    EdgeIds.add(Edge.id)

    const From = edgeRefOf(Edge.from, Edge.id, 'from')
    const To = edgeRefOf(Edge.to, Edge.id, 'to')
    const FromNode = Nodes.get(From.node)
    if (FromNode === undefined) {
      throw new SwarmError('E_SWARM_INVALID', `边指向不存在的节点: ${From.node}`, {
        edge: Edge.id, node: From.node, reason: '上游节点不存在',
      })
    }
    const ToNode = Nodes.get(To.node)
    if (ToNode === undefined) {
      throw new SwarmError('E_SWARM_INVALID', `边指向不存在的节点: ${To.node}`, {
        edge: Edge.id, node: To.node, reason: '下游节点不存在',
      })
    }
    if (!RELATIONS.some((Relation) => Relation.from === FromNode.kind && Relation.to === ToNode.kind)) {
      throw new SwarmError('E_SWARM_INVALID', `无逻辑交换: ${FromNode.kind} → ${ToNode.kind}`, {
        edge: Edge.id, node: To.node, reason: `无逻辑交换: ${FromNode.kind} → ${ToNode.kind}`,
      })
    }

    const Provided = PORT_SCHEMAS[FromNode.kind].output[From.port]
    if (Provided === undefined) {
      throw new SwarmError('E_SWARM_INVALID', `${From.node} 没有输出端口 ${From.port}`, {
        edge: Edge.id, node: From.node, port: From.port, reason: '上游输出端口不存在',
      })
    }
    const Required = PORT_SCHEMAS[ToNode.kind].input[To.port]
    if (Required === undefined) {
      throw new SwarmError('E_SWARM_INVALID', `${To.node} 没有输入端口 ${To.port}`, {
        edge: Edge.id, node: To.node, port: To.port, reason: '下游输入端口不存在',
      })
    }
    const Verdict = isSubschema(Provided, Required, `${From.node}.${From.port}→${To.node}.${To.port}`)
    if (!Verdict.ok) {
      throw new SwarmError(Verdict.unsupported ? 'E_SCHEMA_UNSUPPORTED' : 'E_SWARM_INVALID', `${Edge.id}: ${Verdict.reason}`, {
        edge: Edge.id, node: To.node, port: To.port, path: Verdict.path, reason: Verdict.reason,
      })
    }
  }

  const Remaining = cyclicNodes(Def.nodes, Def.edges)
  if (Remaining.length > 0) {
    throw new SwarmError('E_SWARM_CYCLE', '图存在环路', { node: Remaining[0]!, remaining: Remaining, reason: '图存在环路' })
  }

  if (typeof Def.output !== 'string' || Def.output.trim() === '') {
    throw new SwarmError('E_SWARM_INVALID', 'output_node 必填', { reason: 'output_node 必填' })
  }
  if (!Nodes.has(Def.output)) {
    throw new SwarmError('E_SWARM_INVALID', `输出节点不存在: ${Def.output}`, { node: Def.output, reason: '输出节点不存在' })
  }
}

function edgeRefOf(Value: SwarmEdgeRef, EdgeId: string, Side: 'from' | 'to'): SwarmEdgeRef {
  if (Value === null || typeof Value !== 'object' || Array.isArray(Value)) {
    throw new SwarmError('E_SWARM_INVALID', `边 ${EdgeId} 的 ${Side} 需为对象`, { edge: EdgeId, reason: `${Side} 需为对象` })
  }
  if (typeof Value.node !== 'string' || Value.node.trim() === '') {
    throw new SwarmError('E_SWARM_INVALID', `边 ${EdgeId} 的 ${Side}.node 需为非空字符串`, {
      edge: EdgeId, reason: `${Side}.node 需为非空字符串`,
    })
  }
  if (typeof Value.port !== 'string' || Value.port.trim() === '') {
    throw new SwarmError('E_SWARM_INVALID', `边 ${EdgeId} 的 ${Side}.port 需为非空字符串`, {
      edge: EdgeId, reason: `${Side}.port 需为非空字符串`,
    })
  }
  return { node: Value.node, port: Value.port }
}

function cyclicNodes(Nodes: SwarmNode[], Edges: SwarmEdge[]): string[] {
  const InDegree = new Map<string, number>()
  const Dependents = new Map<string, string[]>()
  for (const Node of Nodes) {
    InDegree.set(Node.id, 0)
    Dependents.set(Node.id, [])
  }
  for (const Edge of Edges) {
    InDegree.set(Edge.to.node, (InDegree.get(Edge.to.node) ?? 0) + 1)
    Dependents.get(Edge.from.node)!.push(Edge.to.node)
  }

  let Ready = Nodes.filter((Node) => InDegree.get(Node.id) === 0).map((Node) => Node.id)
  let Processed = 0
  while (Ready.length > 0) {
    const Next: string[] = []
    for (const Id of Ready) {
      Processed += 1
      for (const Down of Dependents.get(Id)!) {
        const Left = (InDegree.get(Down) ?? 0) - 1
        InDegree.set(Down, Left)
        if (Left === 0) Next.push(Down)
      }
    }
    Ready = Next
  }
  return Processed === Nodes.length ? [] : Nodes.filter((Node) => (InDegree.get(Node.id) ?? 0) > 0).map((Node) => Node.id)
}
