/**
 * 工具侧契约 —— 只住 agent/tool 这一盒的输入/输出形状；Retriever 与 RetrievalResult 仍归 retrieve/contracts.ts，本盒不重抄字段清单。
 * RetrieveToolOutput 是给**模型**读的载荷，不是 HTTP 响应体：检索失败必须 return 成 error 字段，不能 throw
 *   （工具里抛的错被 SDK catch 后走 errorMode:'json'，而 Error.message 是非枚举 own property ⇒ 序列化只剩 {code,name}，中文原因当场丢失，模型会自己编一个）。
 * RetrievedHit 是 RetrievalResult.hits 的**完整投影**：2026-10-20 起它同时是前端「检索命中」面板的数据源
 *   （前端不再另打一次 /retrieve），所以块号 / 偏移 / 两路分数 / dataUri 都得在这里 —— 面板要显示块号与三路分数，
 *   抽屉要显示偏移与来源。模型也会读到这几个字段：每条几十字节，比 content 小一个数量级，一份形状胜过两处各表。
 *   chunkId 与 resourceId 留着：引用标记要按它们回链。
 */

export type { RetrieveToolInput, RetrievedHit, RetrieveToolOutput }

interface RetrieveToolInput {
  prompt: string
  topK: number
}



interface RetrievedHit {
  chunkId: string
  resourceId: string
  chunkIndex: number
  startOffset: number | null
  endOffset: number | null
  docTitle: string
  source: string | null
  dataUri: string
  content: string
  score: number // RRF 名次分，不是相似度
  similarity: number | null
  lexicalScore: number | null
}

interface RetrieveToolOutput {
  hits: RetrievedHit[]
  vectorCount: number // 过阈值后的条数；判「库里没有」用它与 lexicalCount，别用 hits.length（已被 topK 截过）
  lexicalCount: number
  error: { code: string; message: string } | null // 非 null 时 hits 为空、两个 count 为 0
}

interface ResourceToolInput {
  chunckId: string
  returnResource: boolean
  startOffset: number | null
  endOffset: number | null
}

interface ResourceToolOutput{
  resourceId : number 

}
