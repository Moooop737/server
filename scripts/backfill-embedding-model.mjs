/**
 * T2 B0 一次性回填：embeddings.model 从裸 modelId 统一为模型键。
 * 主库从 models 的默认嵌入行取键；评测库配置表为空，沿用主库键（语料是主库复制的同一嵌入模型）。
 * 回填前备份两张表的 id, model 到 _t2_embedding_model_backup；重复执行不会覆盖已有备份。
 * 用法：node --env-file=.env scripts/backfill-embedding-model.mjs
 */

import pg from 'pg'

const { Client } = pg

const MainUrl = process.env.DATABASE_URL
const EvalUrl = process.env.EVAL_DATABASE_URL
if (!MainUrl) {
  console.error('E_DATABASE_URL')
  process.exit(1)
}

async function main() {
  const Main = new Client({ connectionString: MainUrl })
  await Main.connect()
  try {
    const Models = await Main.query("SELECT count(*)::int AS n FROM models WHERE kind = 'embedding'")
    if (Models.rows[0].n !== 1) {
      console.error(`E_NOT_SINGLE_EMBEDDING_MODEL: ${Models.rows[0].n}`)
      process.exit(1)
    }

    const Key = await Main.query(`
      SELECT m.id AS key
        FROM models m
        JOIN models d ON d.kind = 'default' AND d.id = 'embedding'
                     AND d.provider_id = m.provider_id AND d.model_id = m.model_id
       WHERE m.kind = 'embedding'`)
    if (Key.rowCount !== 1) {
      console.error('E_NO_DEFAULT_EMBEDDING_MODEL')
      process.exit(1)
    }
    const ModelKey = Key.rows[0].key
    console.log('model_key', ModelKey)

    await backup(Main, 'main')
    console.log('main updated', await backfill(Main, ModelKey))

    if (EvalUrl) {
      const Eval = new Client({ connectionString: EvalUrl })
      await Eval.connect()
      try {
        await backup(Eval, 'eval')
        console.log('eval updated', await backfill(Eval, ModelKey))
      } finally {
        await Eval.end()
      }
    }
  } finally {
    await Main.end()
  }
}

async function backup(Db, Label) {
  const Exists = await Db.query("SELECT to_regclass('_t2_embedding_model_backup') AS t")
  if (Exists.rows[0].t !== null) {
    console.log(`${Label} backup exists, keep`)
    return
  }
  await Db.query('CREATE TABLE _t2_embedding_model_backup AS SELECT id, model FROM embeddings')
  const Count = await Db.query('SELECT count(*)::int AS n FROM _t2_embedding_model_backup')
  console.log(`${Label} backup rows`, Count.rows[0].n)
}

async function backfill(Db, ModelKey) {
  const Result = await Db.query('UPDATE embeddings SET model = $1 WHERE model <> $1', [ModelKey])
  return Result.rowCount
}

main().catch((Err) => {
  console.error('ERR', Err.message)
  process.exit(1)
})
