/**
 * 会话上下文组装：读历史、把本轮 user 消息落库、转成 AI SDK 的 ModelMessage。
 *
 * loadSessionContext 有写副作用——它会把当前问题作为 user 消息写进 session，再返回两份消息：
 * uiMessages 给 toUIMessageStream 的 originalMessages，modelMessages 给 streamText.messages。
 * 历史只回灌正文：tool parts 里是上一轮的整份命中全文，回灌既撑爆 token，
 * 也让模型可能引用旧 chunk —— 而引用只该来自本轮工具结果（2026-10-21 Lynx 拍）。
 */

export { SessionHistory }

import { convertToModelMessages, type ModelMessage, type UIMessage } from 'ai'
import { inject, singleton } from 'tsyringe'
import { PostgresRepo, type Message, type Repo } from '../../adapter/contract'

interface SessionContext {
  uiMessages: UIMessage[]
  modelMessages: ModelMessage[]
}

@singleton()
class SessionHistory {
  private readonly repo: Repo

  constructor(@inject(PostgresRepo) Repo: Repo) {
    this.repo = Repo
  }

  async loadSessionContext(Query: string, SessionId: string, MessageCount: number): Promise<SessionContext> {
    const Stored = await this.repo.getMessagesBySession(SessionId)
    const History = Stored.slice(-MessageCount).map(toHistoryMessage).filter((Entry): Entry is UIMessage => Entry !== null)
    const UserStored = await this.repo.createMessage({
      session_id: SessionId,
      role: 'user',
      content: Query,
      parts: [{ type: 'text', text: Query }],
    })
    const uiMessages: UIMessage[] = [
      ...History,
      { id: UserStored.id, role: 'user', parts: [{ type: 'text', text: Query }] },
    ]
    const modelMessages = await convertToModelMessages(uiMessages)
    return { uiMessages, modelMessages }
  }
}

function toHistoryMessage(Stored: Message): UIMessage | null {
  const Parts = Stored.parts.filter((Part) => Part.type === 'text')
  if (Parts.length === 0) return null
  return { id: Stored.id, role: Stored.role, parts: Parts }
}
