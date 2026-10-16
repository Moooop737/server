export { createChat }
export type { ChatDeps }

import { streamText } from 'ai'
import type { LanguageModelId, RegistedModels, Repo } from '../../adapter/contract'

interface ChatDeps {
  models: RegistedModels
  chatModel: LanguageModelId
}

function createChat(Deps: ChatDeps): { ask: (prompt: string, signal: AbortSignal) => ReturnType<typeof streamText> } {
  const { models, chatModel } = Deps
  const model = models['languageModels'][chatModel]!
  const ask = (prompt: string, signal: AbortSignal) => streamText({ model, prompt, abortSignal: signal })
  return { ask }
}
