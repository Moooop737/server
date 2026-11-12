/**
 * machine 运行 —— 把编译好的单 worker 跑一次：一条 user 消息进、生成侧出。
 * 只调用传入的 generate（生产是 Chat.generate），不写会话 / 消息 / trace_stages；结果只含回答与工具轨迹。
 */

export { runMachineGraph }
export type { MachineGenerate, MachineRunGraphResult, MachineRunToolCall, MachineRunUsage }

import type { GenerateTextResult, ModelMessage, TelemetryOptions, ToolSet } from 'ai'
import type { ChatCallOptions } from '../../agent/chat/chat'
import type { CompiledMachine } from './machine'

interface MachineRunToolCall {
  step: number
  name: string
  input: unknown
  output: unknown
}

interface MachineRunUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

interface MachineRunGraphResult {
  swarm_id: string
  swarm_version: number | null
  model_key: string
  answer: string
  steps: number
  finish_reason: string
  tool_calls: MachineRunToolCall[]
  usage: MachineRunUsage
}

type MachineGenerate = (
  Messages: ModelMessage[],
  Options: ChatCallOptions<ToolSet>,
) => Promise<GenerateTextResult<ToolSet, any, any>>

async function runMachineGraph(
  Compiled: CompiledMachine,
  Query: string,
  Generate: MachineGenerate,
  Options: { signal?: AbortSignal; telemetry?: TelemetryOptions } = {},
): Promise<MachineRunGraphResult> {
  const Messages: ModelMessage[] = [{ role: 'user', content: Query }]
  const Result = await Generate(Messages, {
    model: Compiled.worker.model,
    instructions: Compiled.worker.instructions,
    tools: Compiled.worker.tools,
    stepLimit: Compiled.worker.step_limit,
    ...(Options.signal === undefined ? {} : { abortSignal: Options.signal }),
    ...(Options.telemetry === undefined ? {} : { telemetry: Options.telemetry }),
  })

  const ToolCalls: MachineRunToolCall[] = []
  Result.steps.forEach((Step, Index) => {
    for (const Call of Step.toolCalls) {
      const ToolResult = Step.toolResults.find((Item) => Item.toolCallId === Call.toolCallId)
      ToolCalls.push({
        step: Index + 1,
        name: Call.toolName,
        input: Call.input,
        output: ToolResult?.output ?? null,
      })
    }
  })

  return {
    swarm_id: Compiled.plan.swarm_id,
    swarm_version: Compiled.plan.swarm_version,
    model_key: Compiled.worker.model_key,
    answer: Result.text,
    steps: Result.steps.length,
    finish_reason: Result.finishReason,
    tool_calls: ToolCalls,
    usage: {
      input_tokens: Result.usage.inputTokens ?? 0,
      output_tokens: Result.usage.outputTokens ?? 0,
      total_tokens: Result.usage.totalTokens ?? 0,
    },
  }
}
