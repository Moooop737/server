/**
 * 工具侧契约 —— 只住 agent/tool 这一盒的输入/输出形状；Retriever 与 RetrievalResult 仍归 retrieve/contracts.ts，本盒不重抄字段清单。
 * RetrieveToolOutput 是给**模型**读的载荷，不是 HTTP 响应体：检索失败必须 return 成 error 字段，不能 throw
 *   （工具里抛的错被 SDK catch 后走 errorMode:'json'，而 Error.message 是非枚举 own property ⇒ 序列化只剩 {code,name}，中文原因当场丢失，模型会自己编一个）。
 * RetrievedHit 是 RetrievalResult.hits 的裁剪版：start_offset / end_offset / similarity / lexicalScore 对作答无用，不进 prompt；
 *   chunkId 与 resourceId 留着，2.3 的引用标记要按它们回链。
 */

export type { RetrieveToolInput, RetrievedHit, RetrieveToolOutput }

interface RetrieveToolInput {
  prompt: string
  topK: number
}

interface RetrievedHit {
  chunkId: string
  resourceId: string
  docTitle: string
  source: string | null
  content: string
  score: number // RRF 名次分，不是相似度
}

interface RetrieveToolOutput {
  hits: RetrievedHit[]
  vectorCount: number // 过阈值后的条数；判「库里没有」用它与 lexicalCount，别用 hits.length（已被 topK 截过）
  lexicalCount: number
  error: { code: string; message: string } | null // 非 null 时 hits 为空、两个 count 为 0
}
