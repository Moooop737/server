/**
 * bm25_recall —— 按原文召回；lexicalScore > 0 才算命中。
 * 词路只负责别漏，不负责够不够好；噪音留给生成侧与阈值。
 */

export { Bm25Recall }

import { z } from 'zod'
import { runStage } from '../../../trace/systemtrace/stage'
import { RankedListSchema } from './schemas'
import { listOf } from './shared'

import type { ComponentDef, Stage } from '../pipeline'
import type { RetrievedChunk } from '../../contracts'

const Bm25RecallConfig = z.strictObject({ top_k: z.number().int().min(1).max(100) })

const Bm25Recall: ComponentDef = {
  name: 'bm25_recall',
  description: '按原文召回；lexicalScore > 0 才算命中',
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
          { query: Text, top_k: C.top_k, node_id: Deps.nodeId },
          () => Deps.repo.lexicalCandidates(Text, C.top_k),
          (Candidates) => ({
            candidates: Candidates.map((Hit, Index) => ({ chunk_id: Hit.chunk.id, lexical_score: Hit.lexicalScore, rank: Index + 1 })),
          }),
        )
        const Items: RetrievedChunk[] = Hits
          .filter((Hit) => Hit.lexicalScore !== null && Hit.lexicalScore > 0)
          .map((Hit) => ({ ...Hit, score: 0 }))
        return { list: listOf('lexical', Items) }
      },
    }
  },
}
