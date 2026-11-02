/**
 * 工具织入 —— 只做两件事：把 entry 的 tool 收成对象，把 catalog / instruction / 全局规则拼成系统提示。
 * 不认识工具名、依赖、context；每个工具模块自己交 entry，worker 决定本轮装哪些。
 */

export { weaveAgentTools }
export type { AgentToolEntry }

import type { Tool, ToolSet } from 'ai'

interface AgentToolEntry {
  name: string
  catalog: string
  instruction: string
  tool: Tool
}

function weaveAgentTools(Entries: AgentToolEntry[], GlobalInstruction: string) {
  const Parts = [catalogOf(Entries), ...Entries.map((Entry) => Entry.instruction), GlobalInstruction]
    .filter((Part) => Part !== '')
  return {
    tools: Object.fromEntries(Entries.map((Entry) => [Entry.name, Entry.tool])) as ToolSet,
    instructions: Parts.join(' '),
  }
}

function catalogOf(Entries: AgentToolEntry[]): string {
  if (Entries.length === 0) return ''
  const List = Entries.map((Entry) => `${Entry.name} (${Entry.catalog})`)
  const Items = List.length === 1 ? List.join('') : `${List.slice(0, -1).join(', ')} and ${List.at(-1) ?? ''}`
  return `You can call ${Entries.length} tools: ${Items}.`
}

