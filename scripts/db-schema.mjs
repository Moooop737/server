import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const OutDir = 'db/.drizzle'
const Target = 'src/adapter/repo/orm/schema.ts'
const Tables = ['resources', 'sessions', 'messages', 'traces', 'trace_stages', 'codebases']

rmSync(OutDir, { recursive: true, force: true })

const Run = spawnSync('npx', ['drizzle-kit', 'introspect', '--config=drizzle.config.ts'], {
  input: 'y\n',
  stdio: ['pipe', 'inherit', 'inherit'],
  env: process.env,
})

if (Run.status !== 0) throw new Error(`drizzle-kit introspect failed: ${Run.status ?? Run.error}`)

let Schema = readFileSync(`${OutDir}/schema.ts`, 'utf8')
Schema = Schema.split('\n')
  .filter((Line) => !/^\s*index\(/.test(Line))
  .join('\n')
Schema = Schema.replace(/, \(table\) => \[([\s\S]*?)\]\);/g, (Match, Body) =>
  Body.includes('table.') ? Match : Match.replace('(table) =>', '() =>'),
)
Schema = Schema.replaceAll("mode: 'string'", "mode: 'date'")
Schema = Schema.replace(/import \{([^}]+)\} from "drizzle-orm\/pg-core"/, (_, Names) => {
  const Kept = Names.split(',')
    .map((Name) => Name.trim())
    .filter((Name) => Name && Name !== 'index')
  return `import { ${Kept.join(', ')} } from "drizzle-orm/pg-core"`
})

for (const Table of Tables) {
  if (!Schema.includes(`pgTable("${Table}"`)) throw new Error(`schema is missing table: ${Table}`)
}
if (/^\s*index\(/m.test(Schema)) throw new Error('index definitions were not stripped')
if (/halfvec|bm25|embeddings/.test(Schema)) throw new Error('search/vector objects leaked into the schema')
if (Schema.includes("mode: 'string'")) throw new Error('timestamp string mode was not normalized')

const Header = `/**
 * 由 \`npm run db:schema\` 生成，含四张 CRUD 表、codebases 与 trace_stages（仅 schema）；timestamptz 用 date 模式。
 * 索引归 dbmate；BM25/向量仍走 search-lexical/search-vector 的裸 SQL。
 * 不要手改。
 */

`
mkdirSync('src/adapter/repo/orm', { recursive: true })
writeFileSync(Target, Header + Schema)
console.log(`schema written: ${Target}`)
