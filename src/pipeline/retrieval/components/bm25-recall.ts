/**
 * bm25_recall —— 按原文召回；lexicalScore > 0 且不低过 min_score 才算命中。
 * min_score 可选，默认只要求 > 0；词路原则上只负责别漏，抬高阈值是在用召回换精度。
 */

export { Bm25Recall }

import { z } from 'zod'
import { runStage } from '../../../trace/systemtrace/stage'
import { RankedListSchema } from './schemas'
import { listOf } from './shared'

import type { ComponentDef, Stage } from '../pipeline'
import type { RetrievedChunk } from '../../contracts'

const Bm25RecallConfig = z.strictObject({
  top_k: z.number().int().min(1).max(100),
  min_score: z.number().min(0).optional(),
})

const Bm25Recall: ComponentDef = {
  name: 'bm25_recall',
  description: '按原文召回；min_score 可选，默认只要求 lexicalScore > 0',
  input: z.object({ text: z.string() }),
  output: z.object({ list: RankedListSchema }),
  config: Bm25RecallConfig,
  create: (Config, Deps): Stage => {
    const C = Bm25RecallConfig.parse(Config)
    return {
      async run(Input) {
        const Text = String(Input.text ?? '')
        const Hits = await runStage(
          Deps.sink,
          'bm25_recall',
          { query: Text, top_k: C.top_k, min_score: C.min_score ?? null, node_id: Deps.nodeId },
          () => Deps.repo.lexicalCandidates(Text, C.top_k),
          (Candidates) => ({
            candidates: Candidates.map((Hit, Index) => ({ chunk_id: Hit.chunk.id, lexical_score: Hit.lexicalScore, rank: Index + 1 })),
          }),
        )
        const Items: RetrievedChunk[] = Hits
          .filter((Hit) => {
            if (Hit.lexicalScore === null || Hit.lexicalScore <= 0) return false
            return C.min_score === undefined || Hit.lexicalScore >= C.min_score
          })
          .map((Hit) => ({ ...Hit, score: 0 }))
        return { list: listOf('lexical', Items) }
      },
    }
  },
}
