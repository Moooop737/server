/**
 * 检索装配 —— assembleRetriever 把管线定义 + 组件表 + 依赖装成 Retriever（每次 search 现装执行）。
 * 管线定义已入库（pipeline_defs，种子在迁移里）；本文件不再有代码内默认管线。
 * 住在 adapter/retrieve：它是「装配规格」，与 Repo 同一层；pipeline/ 只放协议与执行器。
 */

export { RETRIEVAL_COMPONENTS, assembleRetriever }

import { NoopStageSink } from '../../trace/systemtrace/stage'
import { RetrieverError } from '../../retrieve/contracts'
import { executePipeline } from '../../retrieve/pipeline/pipeline'
import { RETRIEVAL_COMPONENTS } from '../../retrieve/pipeline/components'

import type { ComponentDef, PipelineDef } from '../../retrieve/pipeline/pipeline'
import type { RetrievalResult, Retriever, SearchOptions } from '../../retrieve/contracts'
import type { Repo } from '../contract'
import type { RuntimeModelRegistry } from '../model/runtime-registry'

interface RetrieverDeps {
  repo: Repo
  registry: RuntimeModelRegistry
}

function assembleRetriever(Def: PipelineDef, Components: Map<string, ComponentDef>, Deps: RetrieverDeps): Retriever {
  return {
    async search(Query: string, Options?: SearchOptions): Promise<RetrievalResult> {
      const Trimmed = Query.trim()
      if (!Trimmed) throw new RetrieverError('E_EMPTY_QUERY', '提问不能为空')
      const Model = Options?.model?.trim()
      const Run = await executePipeline(
        Def,
        Components,
        {
          repo: Deps.repo,
          registry: Deps.registry,
          sink: Options?.sink ?? NoopStageSink,
        },
        {
          query: Trimmed,
          ...(Model === undefined || Model === '' ? {} : { model: Model }),
        },
      )
      return Run.output as unknown as RetrievalResult
    },
  }
}
