/**
 * 内容 hash —— 去重键与入库完整性校验统一用 SHA-256 小写 hex（64 字符）。
 * 只算字节；文件算原始字节，URL/粘贴算存进 MinIO 的 UTF-8 文本，ingest 对读回的字节复算。
 */

export { sha256Hex, isSha256Hex }

import { createHash } from 'node:crypto'

function sha256Hex(Bytes: Uint8Array | string): string {
  return createHash('sha256').update(Bytes).digest('hex')
}

function isSha256Hex(Value: string): boolean {
  return /^[0-9a-f]{64}$/.test(Value)
}
