export interface Embedder {
  embed(Texts: string[], Options?: { dimensions?: number; signal?: AbortSignal }): Promise<number[][]>
  readonly dimensions: number
}
