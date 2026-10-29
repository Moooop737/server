/**
 * 题集种子导入 —— 读 scripts/eval-cases.json，写进当前评测世界（共享=主库，隔离=评测库）。
 * 跑法：npm run eval:cases:import -- [--file <path>]
 * 单条失败不中断；最后 failed>0 时退出码 1。
 */

import 'reflect-metadata'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { container } from 'tsyringe'
import { EvalAssembly } from '../src/eval/assembly'
import { importCases } from '../src/eval/cases'

import type { CasesSpec } from '../src/eval/cases'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  const File = parseArgs(process.argv.slice(2))
  const Spec = JSON.parse(readFileSync(File, 'utf8')) as CasesSpec
  const Assembly = container.resolve(EvalAssembly)
  console.log(`I_EVAL_CASES_IMPORT mode=${Assembly.mode} file=${File}`)

  const Summary = await importCases(Assembly.repo, Spec)
  for (const Item of Summary.outcomes) {
    if (Item.outcome === 'upserted') console.log(`  ${Item.caseKey} upserted gold=${Item.gold?.length ?? 0}`)
    else console.log(`  ${Item.caseKey} failed ${Item.detail}`)
  }
  console.log(`I_EVAL_CASES_DONE dataset=${Summary.datasetName} upserted=${Summary.upserted} failed=${Summary.failed}`)
  if (Summary.failed > 0) process.exitCode = 1
}

function parseArgs(Argv: string[]): string {
  let File = resolve(SCRIPT_DIR, 'eval-cases.json')
  for (let i = 0; i < Argv.length; i++) {
    const Key = Argv[i]
    if (Key === '--help' || Key === '-h') {
      console.log('用法: npm run eval:cases:import -- [--file <path>]')
      process.exit(0)
    }
    if (Key !== '--file') throw new Error(`未知参数: ${Key}`)
    const Val = Argv[i + 1]
    if (Val === undefined) throw new Error('--file 缺值')
    File = resolve(Val)
    i++
  }
  return File
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (Err: unknown) => {
    console.error(`\neval-cases-import 失败: ${Err instanceof Error ? Err.message : String(Err)}`)
    process.exit(1)
  },
)
