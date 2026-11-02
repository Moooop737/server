/**
 * AppConfig 的失败路径 —— 缺必需 env / 非法 S3 值必须 exit(1) + 结构化错误。
 * AppConfig 的 fail 走 process.exit，不能在本进程断言；这里 spawn 子进程看退出码与 stdout。
 */

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ServerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const Tsx = path.join(ServerRoot, 'node_modules', '.bin', 'tsx')
const Script = "import 'reflect-metadata'; import { container } from 'tsyringe'; import { AppConfig } from './src/config'; container.resolve(AppConfig); console.log('CONFIG_OK')"

const BaseRequired = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x',
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  EMBEDDING_MODEL: 'qwenembed',
  CHAT_MODEL: 'deepseek-v4-flash',
}

function runConfig(Extra: Record<string, string> = {}) {
  const Env: NodeJS.ProcessEnv = { ...process.env }
  for (const Key of Object.keys(Env)) {
    if (Key.startsWith('S3_')) delete Env[Key]
  }
  delete Env.DATABASE_URL
  delete Env.OLLAMA_BASE_URL
  delete Env.EMBEDDING_MODEL
  delete Env.CHAT_MODEL
  delete Env.EVAL_DATABASE_URL
  Object.assign(Env, BaseRequired, Extra)
  const Res = spawnSync(Tsx, ['-e', Script], { cwd: ServerRoot, env: Env, encoding: 'utf8', timeout: 20_000 })
  return { Status: Res.status, Text: `${Res.stdout ?? ''}${Res.stderr ?? ''}`, Error: Res.error }
}

describe('AppConfig 失败路径', () => {
  it('缺 S3_* → E_CONFIG_MISSING，列变量名', () => {
    const Res = runConfig()
    expect(Res.Error).toBeUndefined()
    expect(Res.Status).toBe(1)
    expect(Res.Text).toContain('E_CONFIG_MISSING')
    expect(Res.Text).toContain('S3_ENDPOINT')
    expect(Res.Text).toContain('S3_BUCKET')
    expect(Res.Text).toContain('S3_ACCESS_KEY_ID')
    expect(Res.Text).toContain('S3_SECRET_ACCESS_KEY')
    expect(Res.Text).not.toContain('CONFIG_OK')
  })

  it('S3_ENDPOINT 非 http/https → E_CONFIG_INVALID', () => {
    const Res = runConfig({
      S3_ENDPOINT: 'ftp://127.0.0.1:9000',
      S3_BUCKET: 'kbfile',
      S3_ACCESS_KEY_ID: 'x',
      S3_SECRET_ACCESS_KEY: 'x',
    })
    expect(Res.Status).toBe(1)
    expect(Res.Text).toContain('E_CONFIG_INVALID')
    expect(Res.Text).toContain('S3_ENDPOINT')
  })

  it('S3_FORCE_PATH_STYLE 非 true/false → E_CONFIG_INVALID', () => {
    const Res = runConfig({
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_BUCKET: 'kbfile',
      S3_ACCESS_KEY_ID: 'x',
      S3_SECRET_ACCESS_KEY: 'x',
      S3_FORCE_PATH_STYLE: 'yes',
    })
    expect(Res.Status).toBe(1)
    expect(Res.Text).toContain('E_CONFIG_INVALID')
    expect(Res.Text).toContain('S3_FORCE_PATH_STYLE')
  })

  it('EVAL_DATABASE_URL 与主库相同 → E_CONFIG_INVALID', () => {
    const Res = runConfig({
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_BUCKET: 'kbfile',
      S3_ACCESS_KEY_ID: 'x',
      S3_SECRET_ACCESS_KEY: 'x',
      EVAL_DATABASE_URL: BaseRequired.DATABASE_URL,
    })
    expect(Res.Status).toBe(1)
    expect(Res.Text).toContain('E_CONFIG_INVALID')
    expect(Res.Text).toContain('EVAL_DATABASE_URL')
  })

  it('EVAL_DATABASE_URL 非法 → E_CONFIG_INVALID', () => {
    const Res = runConfig({
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_BUCKET: 'kbfile',
      S3_ACCESS_KEY_ID: 'x',
      S3_SECRET_ACCESS_KEY: 'x',
      EVAL_DATABASE_URL: 'not a url',
    })
    expect(Res.Status).toBe(1)
    expect(Res.Text).toContain('E_CONFIG_INVALID')
  })

  it('没有 EVAL_DATABASE_URL → CONFIG_OK（共享模式，不阻断启动）', () => {
    const Res = runConfig({
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_BUCKET: 'kbfile',
      S3_ACCESS_KEY_ID: 'x',
      S3_SECRET_ACCESS_KEY: 'x',
    })
    expect(Res.Error).toBeUndefined()
    expect(Res.Status).toBe(0)
    expect(Res.Text).toContain('CONFIG_OK')
    
  })

  
})
