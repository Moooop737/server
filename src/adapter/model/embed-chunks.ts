/**
 * embedChunks —— 入库那一批正文走 SDK 的 embedMany 产向量。
 * 30s 超时是入库自己的策略（检索侧不给），与调用方信号合成一个信号，任一触发即中断请求；
 * 中断只掐网络请求，落库改状态那一步绝不复用这个信号（见 ingest/ingest.ts 的 fail()）。
 * 分批：SDK 只按 maxEmbeddingsPerCall（2048）拆，不按单批耗时拆；实测 qwenembed 约 480ms/条，
 * 118 条一次调用 30s 必超 ⇒ 按 32 条顺序发、每批各带一份 30s 超时，结果按批序拼接（顺序与条数同入参）。
 * 入库的向量不走 Langfuse：显式 telemetry:false，阶段耗时由本地 trace_stages 记录（否则全局 integration 会记成独立 trace）。
 */

export { embedChunks }

import { embedMany } from 'ai'
import type { EmbeddingHandle } from '../contract'

const EMBED_TIMEOUT_MS = 30_000
const EMBED_BATCH_SIZE = 32

async function embedChunks(Texts: string[], Target: EmbeddingHandle, Signal?: AbortSignal): Promise<number[][]> {
  const embeddings: number[][] = []

  for (let start = 0; start < Texts.length; start += EMBED_BATCH_SIZE) {
    const signals = [AbortSignal.timeout(EMBED_TIMEOUT_MS)]
    if (Signal) signals.push(Signal)

    const { embeddings: batch } = await embedMany({
      model: Target.model,
      values: Texts.slice(start, start + EMBED_BATCH_SIZE),
      dimensions: Target.dimensions,
      abortSignal: AbortSignal.any(signals),
      telemetry: { isEnabled: false },
    })

    embeddings.push(...batch)
  }

  return embeddings
}
