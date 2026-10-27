/**
 * 代码库硬删 —— 只处理 codebases 行，不复用资源回收站。
 * 先幂等删 MinIO 原 ZIP，再删行；对象已丢失也允许清行；对象删除失败保留行可重试。
 * processing 时拒绝删除，避免把正在校验的行抽走。
 */

export { CodebasePurge, CodebaseDeleteError }

import 'reflect-metadata'
import { inject, singleton } from 'tsyringe'
import { AppConfig } from '../config'
import { ObjectStoreHandle, PostgresCodebaseRepo } from '../adapter/contract'
import type { Codebase, CodebaseRepo } from '../adapter/contract'
import { parseDataUri } from '../adapter/storage/uri'

class CodebaseDeleteError extends Error {
  readonly code: string
  readonly codebase: Codebase | null

  constructor(Code: string, Message: string, Codebase: Codebase | null = null) {
    super(Message)
    this.name = 'CodebaseDeleteError'
    this.code = Code
    this.codebase = Codebase
  }
}

@singleton()
class CodebasePurge {
  private readonly config: AppConfig
  private readonly store: ObjectStoreHandle
  private readonly repo: CodebaseRepo

  constructor(
    @inject(AppConfig) Config: AppConfig,
    @inject(ObjectStoreHandle) Store: ObjectStoreHandle,
    @inject(PostgresCodebaseRepo) Repo: CodebaseRepo,
  ) {
    this.config = Config
    this.store = Store
    this.repo = Repo
  }

  async delete(Id: string): Promise<void> {
    const codebase = await this.repo.getCodebase(Id)
    if (!codebase) throw new CodebaseDeleteError('E_NOT_FOUND', '代码库不存在')
    if (codebase.status === 'processing') {
      throw new CodebaseDeleteError('E_PROCESSING', '代码库正在校验，不能删除', codebase)
    }

    let key: string | null = null
    try {
      const parts = parseDataUri(codebase.data_uri)
      if (parts.bucket === this.config.s3Bucket) key = parts.key
    } catch {
      // data_uri 坏了就没有可定位对象，仍允许清行
    }

    if (key !== null) {
      try {
        await this.store.delete(key)
      } catch {
        throw new CodebaseDeleteError('E_DELETE_STORE', '删除原始 ZIP 失败，代码库行保留', codebase)
      }
    }

    if (!(await this.repo.deleteCodebase(Id))) {
      throw new CodebaseDeleteError('E_NOT_FOUND', '代码库不存在', codebase)
    }
  }
}
