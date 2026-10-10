export interface Embedder {
  // 文本 → 向量；dimensions 默认 1024（AD-4 不变量）
  embed(texts: string[], options?: { dimensions?: number }): Promise<number[][]>
  // 期望维度，供启动时校验一致性（NFR-6）
  readonly dimensions: number
}
