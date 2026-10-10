export interface ChatModel {
  // 非流式：一次性返回完整文本
  generate(prompt: string, context: string): Promise<string>
  // 流式：Story 2.2 主用，token 逐段吐出
  stream(prompt: string, context: string): ReadableStream<Uint8Array>
}
