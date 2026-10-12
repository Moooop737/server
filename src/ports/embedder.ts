export interface Embedder {
  embed(texts: string[], options?: { dimensions?: number }): Promise<number[][]>
  readonly dimensions: number
}
