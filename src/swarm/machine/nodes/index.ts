/**
 * 节点配置契约 —— kind → zod schema；machine 保存时逐节点校验，issue 压成 { node, field, reason }。
 * 未识别的节点类型不在这里报（图结构校验负责）；这里只认配置字段。
 */

export { NODE_CONFIG_SCHEMAS, validateNodeConfigs }
export type { NodeConfigIssue }

import { ConnectorConfigSchema } from './connector'
import { KbConfigSchema } from './kb'
import { RetrieverConfigSchema } from './retriever'
import { WorkerConfigSchema } from './worker'

import type { z } from 'zod'
import type { SwarmNode, SwarmNodeKind } from '../../graph'

const NODE_CONFIG_SCHEMAS: Record<SwarmNodeKind, z.ZodType> = {
  worker: WorkerConfigSchema,
  retriever: RetrieverConfigSchema,
  kb: KbConfigSchema,
  connector: ConnectorConfigSchema,
}

interface NodeConfigIssue {
  node: string
  field: string
  reason: string
}

interface ZodIssueLike {
  code: string
  path: PropertyKey[]
  message: string
  keys?: string[]
  received?: unknown
}

function validateNodeConfigs(Nodes: SwarmNode[]): NodeConfigIssue[] {
  const Issues: NodeConfigIssue[] = []
  for (const Node of Nodes) {
    const Schema = NODE_CONFIG_SCHEMAS[Node.kind]
    if (Schema === undefined) {
      Issues.push({ node: Node.id, field: 'kind', reason: `未知节点类型: ${String(Node.kind)}` })
      continue
    }
    const Parsed = Schema.safeParse(Node.config ?? {})
    if (Parsed.success) continue
    for (const Raw of Parsed.error.issues) {
      const Issue = Raw as ZodIssueLike
      if (Issue.code === 'unrecognized_keys' && Array.isArray(Issue.keys)) {
        for (const Key of Issue.keys) {
          Issues.push({ node: Node.id, field: Key, reason: `未知字段: ${Key}` })
        }
        continue
      }
      Issues.push({
        node: Node.id,
        field: Issue.path.length === 0 ? '(root)' : Issue.path.map(String).join('.'),
        reason: reasonOf(Issue, Node.config ?? {}),
      })
    }
  }
  return Issues
}

function reasonOf(Issue: ZodIssueLike, Config: unknown): string {
  if (Issue.code === 'invalid_type') {
    const Field = Issue.path.map(String).join('.')
    if (Field !== '' && !(Config !== null && typeof Config === 'object' && Field in (Config as Record<string, unknown>))) {
      return '必填'
    }
    return Issue.message.startsWith('Invalid input') ? '字段类型不正确' : Issue.message
  }
  return Issue.message
}
