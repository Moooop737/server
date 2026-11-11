/**
 * 检索组件之间传递的数据 schema —— 所有组件的 input/output 都从这组形状组合。
 * chunk 嵌套完整对象：result 要还原 /retrieve 与工具的 RetrievedChunk 契约，少一层映射就少一处失配。
 * 判别字段（item_kind / kind）参与连线判定，防止结构相同但语义不同的载荷误连。
 */

export { ChunkSchema, RankedItemSchema, SourceCountSchema, RankedListSchema, EmbeddingSchema }
export type { RankedItem, RankedList, Embedding }

import { z } from 'zod'

const ChunkSchema = z.object({
  id: z.string(),
  resource_id: z.string(),
  resource_uri: z.string(),
  chunk_index: z.number().int(),
  content: z.string(),
  start_offset: z.number().int().nullable(),
  end_offset: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
})

const RankedItemSchema = z.object({
  chunk: ChunkSchema,
  docTitle: z.string(),
  source: z.string().nullable(),
  dataUri: z.string(),
  similarity: z.number().nullable(),
  lexicalScore: z.number().nullable(),
  score: z.number(),
})

const SourceCountSchema = z.object({ name: z.string(), count: z.number().int() })

const RankedListSchema = z.object({
  items: z.array(RankedItemSchema),
  sources: z.array(SourceCountSchema),
  item_kind: z.literal('chunk'),
})

const EmbeddingSchema = z.object({
  vector: z.array(z.number()),
  model_key: z.string(),
  dimension: z.number().int(),
  kind: z.literal('embedding'),
})

type RankedItem = z.infer<typeof RankedItemSchema>
type RankedList = z.infer<typeof RankedListSchema>
type Embedding = z.infer<typeof EmbeddingSchema>
