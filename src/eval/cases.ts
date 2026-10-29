/**
 * 题集导入 —— eval-cases.json 的文档级 expect 在「当前评测世界」的库里解析成 chunk 级 gold，再按 (dataset_id, case_key) upsert。
 * path 按 data_uri 后缀解析，必须恰好命中 1 条 ready 资源；chunkIndex 必须指向存在且未删的块，任何不确定都记该条失败，不猜。
 * content_prefix 取块正文 trim 后前 80 字：7.2 用它验证 gold 是否还是原块。
 * 单条失败不中止整批；调用方看 failed 决定退出码。
 */

export { importCases, CONTENT_PREFIX_LENGTH }
export type { CasesSpec, CasesSpecCase, CasesSpecExpect, ImportSummary, CaseOutcome }

import type { EvalGold, EvalAssertions, Repo } from '../adapter/contract'

const CONTENT_PREFIX_LENGTH = 80

interface CasesSpecExpect {
  path: string
  chunkIndex: number
}

interface CasesSpecCase {
  id: string
  level: string
  query: string
  expect: CasesSpecExpect[]
  negative?: boolean
  note?: string
  assertions?: EvalAssertions
}

interface CasesSpec {
  name: string
  cases: CasesSpecCase[]
}

interface CaseOutcome {
  caseKey: string
  outcome: 'upserted' | 'failed'
  detail?: string
  gold?: EvalGold[]
}

interface ImportSummary {
  datasetId: string
  datasetName: string
  upserted: number
  failed: number
  outcomes: CaseOutcome[]
}

async function importCases(Repo: Repo, Spec: CasesSpec): Promise<ImportSummary> {
  if (typeof Spec.name !== 'string' || Spec.name.trim() === '') throw new Error('题集缺 name')
  if (!Array.isArray(Spec.cases) || Spec.cases.length === 0) throw new Error('题集缺 cases')

  const Name = Spec.name.trim()
  const Dataset = (await Repo.listDatasets()).find((Item) => Item.name === Name)
    ?? await Repo.createDataset({ name: Name, note: '' })

  const Outcomes: CaseOutcome[] = []
  for (const Case of Spec.cases) {
    try {
      const Negative = Case.negative === true
      if (typeof Case.id !== 'string' || Case.id.trim() === '') throw new Error('id 缺失')
      if (typeof Case.level !== 'string' || Case.level.trim() === '') throw new Error('level 缺失')
      if (typeof Case.query !== 'string' || Case.query.trim() === '') throw new Error('query 缺失')
      if (!Array.isArray(Case.expect)) throw new Error('expect 缺失')
      if (Negative && Case.expect.length > 0) throw new Error('负例的 expect 必须为空')
      if (!Negative && Case.expect.length === 0) throw new Error('正例至少需要一条 expect')

      const Gold = Negative ? [] : await resolveGold(Repo, Case.expect)
      const Saved = await Repo.upsertCase(Dataset.id, {
        case_key: Case.id,
        level: Case.level,
        query: Case.query,
        negative: Negative,
        note: Case.note ?? '',
        gold: Gold,
        ...(Case.assertions === undefined ? {} : { assertions: Case.assertions }),
      })
      Outcomes.push({ caseKey: Saved.case_key, outcome: 'upserted', gold: Gold })
    } catch (err) {
      Outcomes.push({ caseKey: typeof Case?.id === 'string' ? Case.id : '?', outcome: 'failed', detail: err instanceof Error ? err.message : String(err) })
    }
  }

  return {
    datasetId: Dataset.id,
    datasetName: Dataset.name,
    upserted: Outcomes.filter((Item) => Item.outcome === 'upserted').length,
    failed: Outcomes.filter((Item) => Item.outcome === 'failed').length,
    outcomes: Outcomes,
  }
}

async function resolveGold(Repo: Repo, Expects: CasesSpecExpect[]): Promise<EvalGold[]> {
  const Gold: EvalGold[] = []
  for (const Expect of Expects) {
    if (typeof Expect.path !== 'string' || Expect.path.trim() === '') throw new Error('expect.path 缺失')
    if (!Number.isInteger(Expect.chunkIndex) || Expect.chunkIndex < 0) throw new Error(`expect.chunkIndex 非法: ${Expect.path}`)

    const Resources = await Repo.listResourcesByUriSuffix(Expect.path)
    if (Resources.length !== 1) throw new Error(`path 命中 ${Resources.length} 条 ready 资源: ${Expect.path}`)
    const Resource = Resources[0]!
    const Chunk = await Repo.getChunkByIndex(Resource.id, Expect.chunkIndex)
    if (Chunk === null) throw new Error(`块不存在: ${Expect.path} #${Expect.chunkIndex}`)

    Gold.push({
      data_uri: Resource.data_uri,
      chunk_index: Expect.chunkIndex,
      content_prefix: Chunk.content.trim().slice(0, CONTENT_PREFIX_LENGTH),
    })
  }
  return Gold
}
