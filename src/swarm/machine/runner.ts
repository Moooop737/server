/**
 * machine 运行器 —— 读 machine（存在 / 启用）→ 编译绑定图 → 单 worker 同步跑一次。
 * 不写会话历史；provider 错误复用 classifyChatError 的 code / statusCode；编译失败带可定位 issues。
 */

export { MachineRunner, MachineRunError }
export type { MachineRunResult }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { PostgresMachineRepo } from '../../adapter/contract'
import { Chat } from '../../agent/chat/chat'
import { classifyChatError } from '../../agent/chat/outcome'
import { MachineAssembly } from './assembly'
import { runMachineGraph } from './runtime'

import type { MachineIssue } from './machine'
import type { MachineRunGraphResult } from './runtime'

interface MachineRunResult extends MachineRunGraphResult {
  machine_id: string
}

class MachineRunError extends Error {
  readonly code: string
  readonly status: number
  readonly errors: MachineIssue[] | undefined

  constructor(Code: string, Message: string, Status: number, Errors?: MachineIssue[]) {
    super(Message)
    this.name = 'MachineRunError'
    this.code = Code
    this.status = Status
    this.errors = Errors
  }
}

@singleton()
class MachineRunner {
  private readonly assembly: MachineAssembly
  private readonly machines: PostgresMachineRepo

  constructor(
    @inject(MachineAssembly) Assembly: MachineAssembly,
    @inject(PostgresMachineRepo) Machines: PostgresMachineRepo,
  ) {
    this.assembly = Assembly
    this.machines = Machines
  }

  async run(MachineId: string, Query: string, Signal?: AbortSignal): Promise<MachineRunResult> {
    const Machine = await this.machines.readMachineById(MachineId)
    if (Machine === null) {
      throw new MachineRunError('E_MACHINE_NOT_FOUND', `machine 不存在: ${MachineId}`, 404)
    }
    if (!Machine.enabled) {
      throw new MachineRunError('E_MACHINE_DISABLED', 'machine 未启用', 409)
    }

    const Compiled = await this.assembly.compile(Machine.swarm_id)
    if (!Compiled.ok) {
      throw new MachineRunError('E_MACHINE_NOT_READY', 'machine 绑定图未通过装配预检', 409, Compiled.errors)
    }

    const Engine = new Chat()
    try {
      const Result = await runMachineGraph(
        Compiled.compiled,
        Query,
        (Messages, Options) => Engine.generate(Messages, Options),
        {
          ...(Signal === undefined ? {} : { signal: Signal }),
          telemetry: { functionId: 'machine.run' },
        },
      )
      return { machine_id: Machine.id, ...Result }
    } catch (Err) {
      if (Signal?.aborted) {
        throw new MachineRunError('E_MACHINE_ABORTED', '运行已取消', 499)
      }
      const Failure = classifyChatError(Err)
      throw new MachineRunError(Failure.code, Failure.message, Failure.statusCode ?? 502)
    }
  }
}
