/**
 * 评测世界装配 —— 只决定评测用哪个库：retriever(Definition) 按冻结的管线定义在「本世界数据 repo」上装配。
 * 管线定义来自 run 快照（创建时冻结），所以评测结果与当时的管线版本绑定；不再问运行时注册表。
 * 不再持有 embedding（D17）；创建 run 需要快照时由 routes/eval 直接问 RuntimeModelRegistry。
 */

export { EvalAssembly }
export type { EvalMode }

import 'reflect-metadata'
import { container, inject, singleton } from 'tsyringe'
import { AppConfig } from '../config'
import { EvalPostgresRepo, PostgresRepo, RETRIEVAL_COMPONENTS, assembleRetriever } from '../adapter/contract'
import { RuntimeModelRegistry } from '../adapter/model/runtime-registry'

import type { Repo } from '../adapter/contract'
import type { Retriever } from '../retrieve/contracts'
import type { PipelineDef } from '../retrieve/pipeline/pipeline'

type EvalMode = 'shared' | 'isolated'

@singleton()
class EvalAssembly {
  readonly mode: EvalMode
  readonly repo: Repo
  private readonly models: RuntimeModelRegistry

  constructor(
    @inject(AppConfig) Config: AppConfig,
    @inject(PostgresRepo) MainRepo: Repo,
    @inject(RuntimeModelRegistry) Models: RuntimeModelRegistry,
  ) {
    this.models = Models
    if (!Config.evalDatabaseUrl) {
      this.mode = 'shared'
      this.repo = MainRepo
      return
    }

    this.mode = 'isolated'
    this.repo = container.resolve(EvalPostgresRepo)
  }

  retriever(Definition: PipelineDef): Retriever {
    return assembleRetriever(Definition, RETRIEVAL_COMPONENTS, { repo: this.repo, registry: this.models })
  }
}
