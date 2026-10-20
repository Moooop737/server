export { createChat }

import { streamText } from 'ai'
import type { ChatHandle } from '../../adapter/contract'

function createChat(Handle: ChatHandle): { ask: (prompt: string, signal: AbortSignal) => ReturnType<typeof streamText> } {
  const model = Handle.model
  const ask = (prompt: string, signal: AbortSignal) => streamText({ model, prompt, abortSignal: signal })
  return { ask }
}
