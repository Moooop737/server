// chunk stage 的配置。常量对齐 WeKnora splitter.go 的 DefaultChunkSize/Overlap/Separators。

export type ChunkStrategyName = 'legacy' | 'recursive' | 'fixed'

export interface ChunkerConfig {
  chunkSize?: number
  chunkOverlap?: number
  separators?: string[]
  strategy?: ChunkStrategyName
}

export interface ResolvedChunkerConfig {
  chunkSize: number
  chunkOverlap: number
  separators: string[]
}

const DEFAULT_CHUNK_SIZE = 512
const DEFAULT_CHUNK_OVERLAP = 80
const DEFAULT_SEPARATORS = ['\n\n', '\n', '。']

// 把可选配置补全成必填；overlap 超过 chunkSize/2 就压到一半，
// 否则相邻块 90% 内容重复，等于同一段话存十几遍（向量冗余 + 检索全是重复命中）。
export function resolveChunkerConfig(cfg: ChunkerConfig = {}): ResolvedChunkerConfig {
  const chunkSize = cfg.chunkSize && cfg.chunkSize > 0 ? cfg.chunkSize : DEFAULT_CHUNK_SIZE

  let chunkOverlap = cfg.chunkOverlap && cfg.chunkOverlap > 0 ? cfg.chunkOverlap : DEFAULT_CHUNK_OVERLAP
  if (chunkOverlap > chunkSize / 2) chunkOverlap = Math.floor(chunkSize / 2)

  const separators = cfg.separators && cfg.separators.length > 0 ? cfg.separators : [...DEFAULT_SEPARATORS]

  return { chunkSize, chunkOverlap, separators }
}
