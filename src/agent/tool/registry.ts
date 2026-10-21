/**
 * 工具登记表 —— 键名即下发给前端的 part 名（`tool-${NAME}`），改键名要连前端一起改。
 * 依赖走闭包，所以这里没有 contextSchema：streamText 那侧的 toolsContext 被推成 never（传了就是编译错），
 *   Retriever 由 ChatService 构造期经 buildAgentTools 烧进每只工具的 execute。
 */

export { buildAgentTools }

import { buildRetrieveTool } from './tools/retrieve'

import type { Retriever } from '../../retrieve/contracts'

function buildAgentTools(Retriever: Retriever) {
  return { retrieve: buildRetrieveTool(Retriever) }
}
