/**
 * 评测世界装配 —— 只决定评测用哪个库：共享模式复用主库的 Repo / Retriever；隔离模式只换 Repo，
 * 交由主 RetrieverHandle.forRepo 用同一份 factory/embedding/config 重建 retriever。
 * ObjectStore / Embedding / RetrieverFactory 等无状态或外部句柄共享，不把 Repo 改成多实例容器。
 * 共享 vs 隔离是启动期 env 选择（EVAL_DATABASE_URL），不做运行时切换；共享模式不碰评测库连接。
 */

export { EvalAssembly }
export type { EvalMode }

import 'reflect-metadata'
import { container, inject, singleton } from 'tsyringe'
import { AppConfig } from '../config'
import { EmbeddingHandle, EvalPostgresRepo, PostgresRepo, RetrieverHandle } from '../adapter/contract'

import type { Repo } from '../adapter/contract'
import type { Retriever } from '../retrieve/contracts'

type EvalMode = 'shared' | 'isolated'

@singleton()
class EvalAssembly {
  readonly mode: EvalMode
  readonly repo: Repo
  readonly retriever: Retriever
  readonly embedding: EmbeddingHandle

  constructor(
    @inject(AppConfig) Config: AppConfig,
    @inject(PostgresRepo) MainRepo: Repo,
    @inject(EmbeddingHandle) Embedding: EmbeddingHandle,
    @inject(RetrieverHandle) MainHandle: RetrieverHandle,
  ) {
    this.embedding = Embedding
    if (!Config.evalDatabaseUrl) {
      this.mode = 'shared'
      this.repo = MainRepo
      this.retriever = MainHandle.retriever
      return
    }

    this.mode = 'isolated'
    const EvalRepo = container.resolve(EvalPostgresRepo)
    this.repo = EvalRepo
    this.retriever = MainHandle.forRepo(EvalRepo)
  }
}
