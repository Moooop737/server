/**
 * 问答编排 —— createChat({ repo, retriever }) 交出可执行对象 { ask }。AD-1 里问答那条路径的入口层，不含 HTTP、不含生成。
 * ask 的次序是定死的，每一条都为了少花一次上游调用：trim 判空 → 数资源（空库／全无 ready 直接成答案，根本不检索）→ retriever.search → 两路都空才算「未找到」。
 * 「未找到」判的是 vectorCount/lexicalCount 而不是 hits.length：hits 已被 limit 截过，看不出来源（契约见 retrieve/contracts.ts 的 Retriever）。
 * 三条提示文案是 AC 规定的**答案**而非错误，由路由按 200 下发。
 * 有命中时 answer 暂时是空串、hits 原样带出：生成侧卡在未决的「模型怎么表态」（deferred-work 2026-10-14），接上后这里换成模型回答 + sources。
 * Limit 是融合后送进上下文的条数，缺省交给 Fuser 回落 config.defaultLimit。
 * 结果码：E_EMPTY_QUERY 空或纯空白提问。本层与 Retriever 各守自己的入口 —— 端口不假设调用方已经判过。
 */

export { createChat, ChatError }

export type { Chat, ChatAnswer, ChatDeps }

import type { Repository } from '../../ports/repository'
import type { Retriever, RetrievalResult } from '../../retrieve/contracts'

interface ChatDeps {
  repo: Repository
  retriever: Retriever
}

interface ChatAnswer {
  answer: string
  result: RetrievalResult | null // null = 还没走到检索（空库／全无 ready）
}

interface Chat {
  ask(Query: string, Limit?: number): Promise<ChatAnswer>
}

class ChatError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ChatError'
    this.code = code
  }
}

function createChat(Deps: ChatDeps): Chat {
  const { repo, retriever } = Deps

  const ask = async (Query: string, Limit?: number): Promise<ChatAnswer> => {
    const trimmed = Query.trim()
    if (!trimmed) throw new ChatError('E_EMPTY_QUERY', '提问不能为空')

    const counts = await repo.countResourcesByStatus()
    const total = counts.ready + counts.processing + counts.failed
    if (total === 0) return { answer: '尚未添加任何资源', result: null }
    if (counts.ready === 0) {
      return { answer: `暂无可用资源（${counts.processing + counts.failed} 条入库失败/处理中）`, result: null }
    }

    const result = await retriever.search(trimmed, Limit === undefined ? undefined : { limit: Limit })
    if (result.vectorCount === 0 && result.lexicalCount === 0) {
      return { answer: '知识库中未找到相关内容', result }
    }

    return { answer: '', result }
  }

  return { ask }
}
