/**
 * embedChunks —— 入库那一批正文走 SDK 的 embedMany 产向量。
 * 30s 超时是入库自己的策略（检索侧不给），与调用方信号合成一个信号，任一触发即中断请求；
 * 中断只掐网络请求，落库改状态那一步绝不复用这个信号（见 ingest/ingest.ts 的 fail()）。
 * 分批不用自己管：句柄自报 maxEmbeddingsPerCall（实测 2048），超出由 SDK 拆批，返回顺序与条数同入参（实测）。
 */

export { embedChunks }

import { embedMany } from 'ai'
import type { EmbeddingTarget } from '../contract'

const EMBED_TIMEOUT_MS = 30_000

async function embedChunks(Texts: string[], Target: EmbeddingTarget, Signal?: AbortSignal): Promise<number[][]> {
  const signals = [AbortSignal.timeout(EMBED_TIMEOUT_MS)]
  if (Signal) signals.push(Signal)

  const { embeddings } = await embedMany({
    model: Target.model,
    values: Texts,
    dimensions: Target.dimensions,
    abortSignal: AbortSignal.any(signals),
  })

  return embeddings
}
