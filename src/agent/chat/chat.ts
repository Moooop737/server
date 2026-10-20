export { ChatService }

import { stepCountIs, streamText, type ToolSet } from 'ai'
import { ChatHandle, RetrieverHandle } from '../../adapter/contract'
import { inject, singleton } from 'tsyringe';
import { buildAgentTools } from '../tool/registry';
import type { LanguageModelV4 } from '@ai-sdk/provider';

@singleton()
class ChatService {
  private readonly tools: ToolSet          // 构造期建一次，不是每请求
  private readonly model: LanguageModelV4

  constructor(
    @inject(ChatHandle) Handle: ChatHandle,
    @inject(RetrieverHandle) R: RetrieverHandle) {
    this.model = Handle.model
    this.tools = buildAgentTools(R.retriever)
  }

  ask(prompt: string, signal: AbortSignal) {
    return streamText({ model: this.model, prompt, tools: this.tools, stopWhen: stepCountIs(2), abortSignal: signal })
  }
}
