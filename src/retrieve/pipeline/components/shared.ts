/**
 * 组件共用工具 —— 只放跨组件复用、且不携带业务状态的纯函数与快照断言。
 * requireEmbedding 是组件内兜底：正常路径执行器已保证 requiresEmbedding 组件拿到快照，这里防绕过执行器的直接调用。
 */

export { requireEmbedding, embedText, listOf, rrf, hashVector }

import { createHash } from 'node:crypto'
import { embedMany } from 'ai'
import { RetrieverError } from '../../contracts'

import type { EmbeddingModelV4 } from '@ai-sdk/provider'
import type { ComponentDeps } from '../pipeline'
import type { RetrievedChunk } from '../../contracts'
import type { RuntimeModel } from '../../../adapter/config/runtime'
import type { RankedItem, RankedList } from './schemas'

function requireEmbedding(Deps: ComponentDeps): RuntimeModel {
  if (Deps.embedding === null) {
    throw new RetrieverError('E_NO_EMBEDDING_MODEL', '未配置可用的默认嵌入模型')
  }
  return Deps.embedding
}

async function embedText(Embedding: RuntimeModel, Text: string, Telemetry: boolean): Promise<number[]> {
  const Handle = Embedding.model as EmbeddingModelV4 | null
  if (Handle === null || Embedding.dimensions === null) {
    throw new RetrieverError('E_NO_EMBEDDING_MODEL', '未配置可用的默认嵌入模型')
  }
  const { embeddings } = await embedMany({
    model: Handle,
    values: [Text],
    dimensions: Embedding.dimensions,
    ...(Telemetry ? {} : { telemetry: { isEnabled: false } }),
  })
  const First = embeddings[0]
  if (!First) throw new Error('EmbeddingModelV4 违约：N 进 N 出未兑现')
  return First
}

function listOf(Name: string, Items: RetrievedChunk[]): RankedList {
  return { items: Items, sources: [{ name: Name, count: Items.length }], item_kind: 'chunk' }
}

function rrf(Lists: RankedList[], K: number, Weights: number[] = []): RankedList {
  const Merged = new Map<string, RankedItem>()
  const Sources = new Map<string, number>()
  Lists.forEach((List, ListIndex) => {
    for (const Source of List.sources) {
      Sources.set(Source.name, (Sources.get(Source.name) ?? 0) + Source.count)
    }
    List.items.forEach((Item, Index) => {
      const Contribution = (Weights[ListIndex] ?? 1) / (K + Index + 1)
      const Prev = Merged.get(Item.chunk.id)
      if (Prev) {
        Prev.score += Contribution
      } else {
        Merged.set(Item.chunk.id, { ...Item, score: Contribution })
      }
    })
  })
  return {
    items: [...Merged.values()].sort((A, B) => B.score - A.score),
    sources: [...Sources].map(([Name, Count]) => ({ name: Name, count: Count })),
    item_kind: 'chunk',
  }
}

function hashVector(Vector: number[]): string {
  return createHash('sha256').update(JSON.stringify(Vector)).digest('hex').slice(0, 16)
}
