/**
 * 运行快照组装 —— 把“这次跑的是什么”复制成一份只读输入：题集逐条（含 gold）、两份配置、冻结的检索管线、embedding 模型/维度、语料计数。
 * 只做深拷贝式映射，不查库；调用方在 POST /eval/runs 时一次性算好，之后改题集/配置/管线都不影响历史 run。
 */

export { buildSnapshot }
export type { SnapshotInput }

import { resolveRubric } from './judge'
import type { EvalCase, EvalConfig, EvalDataset, EvalRunSnapshot, ResourceCounts } from '../adapter/contract'
import type { PipelineNode } from '../retrieve/pipeline/pipeline'

interface SnapshotInput {
  dataset: EvalDataset
  cases: EvalCase[]
  runConfig: EvalConfig
  metricConfig: EvalConfig
  mode?: 'retrieval' | 'answer'
  embedding: { model: string; dimensions: number }
  corpus: ResourceCounts
  pipeline: { version: number; nodes: PipelineNode[]; output: string | null }
}

function buildSnapshot(Input: SnapshotInput): EvalRunSnapshot {
  const Judge = Input.metricConfig.config.judge_model
  const JudgeConfigured = typeof Judge === 'string' && Judge.trim() !== ''
  return {
    dataset: { id: Input.dataset.id, name: Input.dataset.name, note: Input.dataset.note },
    cases: Input.cases.map((Item) => ({
      case_key: Item.case_key,
      level: Item.level,
      query: Item.query,
      negative: Item.negative,
      note: Item.note,
      gold: Item.gold.map((Gold) => ({ ...Gold })),
      assertions: {
        expect: Item.assertions.expect.map((Item2) => ({ ...Item2 })),
        reject: Item.assertions.reject.map((Item2) => ({ ...Item2 })),
      },
    })),
    run_config: { id: Input.runConfig.id, name: Input.runConfig.name, config: { ...Input.runConfig.config } },
    metric_config: { id: Input.metricConfig.id, name: Input.metricConfig.name, config: { ...Input.metricConfig.config } },
    rubric: JudgeConfigured ? resolveRubric(Input.metricConfig.config.rubric) : null,
    ...(Input.mode === undefined ? {} : { mode: Input.mode }),
    embedding: { model: Input.embedding.model, dimensions: Input.embedding.dimensions },
    corpus: { ...Input.corpus },
    pipeline: {
      version: Input.pipeline.version,
      nodes: Input.pipeline.nodes.map((Node) => ({ ...Node })),
      output: Input.pipeline.output,
    },
  }
}
