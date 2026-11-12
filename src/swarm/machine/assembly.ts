/**
 * machine 装配服务 —— 预检把已存图或草稿整图交给 assembleMachine；运行 compile 只认已存图，交给 compileMachine。
 * 纯读：预检不写库、不调模型；compile 只多交出可执行 worker，不启动运行。
 */

export { MachineAssembly }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { PostgresPipelineRepo, PostgresRepo, PostgresSwarmRepo } from '../../adapter/contract'
import { RuntimeModelRegistry } from '../../adapter/model/runtime-registry'
import { assembleMachine, compileMachine } from './machine'

import type { Repo } from '../../adapter/contract'
import type { MachineCompileResult, MachinePreflightResult } from './machine'
import type { SwarmGraphDef } from '../graph'

@singleton()
class MachineAssembly {
  private readonly registry: RuntimeModelRegistry
  private readonly pipelines: PostgresPipelineRepo
  private readonly repo: Repo
  private readonly swarms: PostgresSwarmRepo

  constructor(
    @inject(RuntimeModelRegistry) Registry: RuntimeModelRegistry,
    @inject(PostgresPipelineRepo) Pipelines: PostgresPipelineRepo,
    @inject(PostgresRepo) Repo: Repo,
    @inject(PostgresSwarmRepo) Swarms: PostgresSwarmRepo,
  ) {
    this.registry = Registry
    this.pipelines = Pipelines
    this.repo = Repo
    this.swarms = Swarms
  }

  async preflight(SwarmId: string, Graph?: SwarmGraphDef): Promise<MachinePreflightResult> {
    if (Graph !== undefined) {
      return assembleMachine(
        { swarm_id: SwarmId, swarm_version: null, graph: Graph },
        { registry: this.registry, pipelines: this.pipelines, repo: this.repo },
      )
    }

    const Row = await this.swarms.readSwarmById(SwarmId)
    if (Row === null) {
      return {
        ok: false,
        errors: [{
          code: 'E_MACHINE_SWARM_NOT_FOUND',
          node: null,
          edge: null,
          port: null,
          field: null,
          reason: `图不存在: ${SwarmId}`,
        }],
      }
    }
    return assembleMachine(
      {
        swarm_id: SwarmId,
        swarm_version: Row.version,
        graph: { nodes: Row.nodes, edges: Row.edges, output: Row.output_node },
      },
      { registry: this.registry, pipelines: this.pipelines, repo: this.repo },
    )
  }

  async compile(SwarmId: string): Promise<MachineCompileResult> {
    const Row = await this.swarms.readSwarmById(SwarmId)
    if (Row === null) {
      return {
        ok: false,
        errors: [{
          code: 'E_MACHINE_SWARM_NOT_FOUND',
          node: null,
          edge: null,
          port: null,
          field: null,
          reason: `图不存在: ${SwarmId}`,
        }],
      }
    }
    return compileMachine(
      {
        swarm_id: SwarmId,
        swarm_version: Row.version,
        graph: { nodes: Row.nodes, edges: Row.edges, output: Row.output_node },
      },
      { registry: this.registry, pipelines: this.pipelines, repo: this.repo },
    )
  }
}
