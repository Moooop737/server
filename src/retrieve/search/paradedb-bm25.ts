/**
 * ParadeDbBm25Search —— 词法检索 stage，走 ParadeDB pg_search 的 BM25 索引 chunks_bm25（中文 Lindera 分词）。
 * 查询走 paradedb.match_disjunction('content', ?)：**把问句交给索引的同一个分词器，token 之间取 OR**，不解析查询语法。
 *   实测（test/probe-bm25-strategies.ts，8 条问句）把问句裸串交给 `@@@` 是错的：
 *   · 抛错 3 条 —— `it's a test` / `a:b` / `AND` 都被解析器当语法（报 "could not parse query string"），直接 500；
 *   · 静默 0 命中 4 条 —— 含 `设置入口：右上角`，而库里那条 chunk 正文就写着「设置入口：在 Qoder CN IDE 的右上角」（全角冒号把 token 黏住了）。
 *   另两条候选：match_conjunction（要求所有 token 同块，自然语言问句 8 条里 7 条为 0，不可用）；
 *   parse(q, lenient=>true)（止住了抛错，但上面那几个 0 命中一个都没救回来）。
 * 命中判定只用 `score > 0`：P1 的词路负责「别漏」，不负责「够不够好」—— OR 语义必然带噪音，挡噪音是生成侧的事（见 deferred-work 2026-10-14）。
 * 相似度分数、名次分都不在这里产出：score 字段留给 Fuser 填，本 stage 只填 lexicalScore。
 * 软删谓词与向量路同口径，只加 `r.deleted_at IS NULL`。字段名 'content' 必须与索引的 text_fields 键一致。
 */

export { ParadeDbBm25Search }

import type { Pool } from 'pg'
import type { RetrievedChunk } from '../contracts'
import type { LexicalSearcher, RetrieverDeps } from '../contracts'
import { rowToChunk } from '../../adapters/paradedb-repository'

class ParadeDbBm25Search implements LexicalSearcher {
  private readonly pool: Pool

  constructor(Deps: RetrieverDeps) {
    this.pool = Deps.pool
  }

  async search(QueryText: string, Limit: number): Promise<RetrievedChunk[]> {
    const { rows } = await this.pool.query(
      `SELECT c.*, r.title AS doc_title, r.source AS source, r.data_uri AS data_uri,
              paradedb.score(c.id) AS lexical_score
         FROM chunks c
         JOIN resources r ON r.id = c.resource_id AND r.deleted_at IS NULL
        WHERE c.content @@@ paradedb.match_disjunction('content', $1)
        ORDER BY lexical_score DESC
        LIMIT $2`,
      [QueryText, Limit]
    )

    return rows
      .map((row: Record<string, unknown>) => ({
        chunk: rowToChunk(row),
        docTitle: String(row.doc_title),
        source: row.source === null ? null : String(row.source),
        dataUri: String(row.data_uri),
        score: 0, // 融合前没有名次分，由 Fuser 填
        similarity: null,
        lexicalScore: Number(row.lexical_score),
      }))
      .filter((hit) => hit.lexicalScore > 0)
  }
}
