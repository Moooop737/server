/**
 * 配置密文 —— AES-256-GCM 信封，只给 API Key 与 headers 两处用。
 * 信封 v1:<base64url(iv)>:<base64url(tag)>:<base64url(ciphertext)>；IV 12 字节、tag 16 字节、key 32 字节。
 * AAD 由调用方给：API Key 用 provider.id，headers 用 `${provider.id}:headers`，两处密文不可互换。
 * parseSecretKey：env 空/缺省返回 null；非 32 字节或非 base64 抛 E_CONFIG_SECRET_KEY。
 * decryptSecret 的任何失败都收敛成 E_SECRET_DECRYPT；错误信息不回显密文、Key、明文。
 * 本文件不访问网络或数据库。
 */

export { parseSecretKey, encryptSecret, decryptSecret, ConfigSecretError }
export type { ConfigSecretErrorCode }

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

type ConfigSecretErrorCode = 'E_CONFIG_SECRET_KEY' | 'E_SECRET_ENCRYPT' | 'E_SECRET_DECRYPT'

class ConfigSecretError extends Error {
  readonly code: ConfigSecretErrorCode

  constructor(Code: ConfigSecretErrorCode, Message: string) {
    super(Message)
    this.name = 'ConfigSecretError'
    this.code = Code
  }
}

const VERSION = 'v1'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

function parseSecretKey(Raw: string | undefined): Buffer | null {
  const Value = Raw?.trim() ?? ''
  if (Value === '') return null
  const Key = Buffer.from(Value, 'base64')
  if (Key.length !== KEY_BYTES) {
    throw new ConfigSecretError('E_CONFIG_SECRET_KEY', `CONFIG_SECRET_KEY 需为 ${KEY_BYTES} 字节的 base64，实际 ${Key.length} 字节`)
  }
  return Key
}

function encryptSecret(Plaintext: string, Key: Buffer, Aad: string): string {
  assertKey(Key)
  if (Plaintext === '') throw new ConfigSecretError('E_SECRET_ENCRYPT', '明文不能为空')
  try {
    const Iv = randomBytes(IV_BYTES)
    const Cipher = createCipheriv('aes-256-gcm', Key, Iv)
    Cipher.setAAD(Buffer.from(Aad, 'utf8'))
    const Body = Buffer.concat([Cipher.update(Plaintext, 'utf8'), Cipher.final()])
    return `${VERSION}:${Iv.toString('base64url')}:${Cipher.getAuthTag().toString('base64url')}:${Body.toString('base64url')}`
  } catch (Err) {
    throw new ConfigSecretError('E_SECRET_ENCRYPT', `加密失败: ${reason(Err)}`)
  }
}

function decryptSecret(Envelope: string, Key: Buffer, Aad: string): string {
  assertKey(Key)
  const Parts = Envelope.split(':')
  const [Version, IvRaw, TagRaw, BodyRaw] = Parts
  if (Parts.length !== 4 || Version !== VERSION || IvRaw === undefined || TagRaw === undefined || BodyRaw === undefined) {
    throw new ConfigSecretError('E_SECRET_DECRYPT', '密文信封格式不合法')
  }
  const Iv = decodePart(IvRaw, IV_BYTES, 'iv')
  const Tag = decodePart(TagRaw, TAG_BYTES, 'tag')
  const Body = decodePart(BodyRaw, null, 'ciphertext')
  try {
    const Decipher = createDecipheriv('aes-256-gcm', Key, Iv)
    Decipher.setAAD(Buffer.from(Aad, 'utf8'))
    Decipher.setAuthTag(Tag)
    return Buffer.concat([Decipher.update(Body), Decipher.final()]).toString('utf8')
  } catch {
    throw new ConfigSecretError('E_SECRET_DECRYPT', '密文校验失败')
  }
}

function assertKey(Key: Buffer): void {
  if (Key.length !== KEY_BYTES) {
    throw new ConfigSecretError('E_CONFIG_SECRET_KEY', `密钥需为 ${KEY_BYTES} 字节`)
  }
}

function decodePart(Raw: string, Expected: number | null, Name: string): Buffer {
  const Part = Buffer.from(Raw, 'base64url')
  if (Part.length === 0 || (Expected !== null && Part.length !== Expected)) {
    throw new ConfigSecretError('E_SECRET_DECRYPT', `密文信封的 ${Name} 长度不合法`)
  }
  return Part
}

function reason(Err: unknown): string {
  return Err instanceof Error ? Err.message : String(Err)
}