/**
 * 对象存储的对外形状与错误语义 —— adapter/contract.ts 的 ObjectStoreHandle 实现它，storage/s3.ts 提供 S3 实现。
 * get/stat 只在对象不存在时返回 null；桶不存在、无权限、网络失败等一律抛 ObjectStoreError（code='E_OBJECT_STORE'）。
 * presignGet 只做本地签名、不访问网络；expiresIn 限 1–604800 秒。
 */

export type { ObjectStore, ObjectStat, ObjectBody, ObjectGetOptions, ObjectPresignOptions, ObjectPresignPutOptions }
export { ObjectStoreError, OBJECT_STORE_ERROR_CODE, PRESIGN_MIN_SECONDS, PRESIGN_MAX_SECONDS, ensureExpiresIn }

import type { Readable } from 'node:stream'

interface ObjectStat {
  size: number
  contentType: string | null
  etag: string | null
}

interface ObjectBody {
  body: Readable
  contentType: string | null
  contentLength: number | null
  etag: string | null
}

interface ObjectGetOptions {
  range?: string
}

interface ObjectPresignOptions {
  expiresIn: number
  responseContentDisposition?: string
  responseContentType?: string
  responseCacheControl?: string
}

interface ObjectPresignPutOptions {
  expiresIn: number
  contentType?: string
}

interface ObjectStore {
  put(Key: string, Body: Uint8Array, ContentType: string): Promise<void>
  stat(Key: string): Promise<ObjectStat | null>
  get(Key: string, Options?: ObjectGetOptions): Promise<ObjectBody | null>
  delete(Key: string): Promise<void>
  presignGet(Key: string, Options: ObjectPresignOptions): Promise<string>
  presignPut(Key: string, Options: ObjectPresignPutOptions): Promise<string>
  ping(): Promise<void>
  ensureBucket(): Promise<void>
}

const OBJECT_STORE_ERROR_CODE = 'E_OBJECT_STORE'
const PRESIGN_MIN_SECONDS = 1
const PRESIGN_MAX_SECONDS = 604800

class ObjectStoreError extends Error {
  readonly code = OBJECT_STORE_ERROR_CODE
  readonly detail: string | null

  constructor(Message: string, Cause?: unknown) {
    super(Message)
    this.name = 'ObjectStoreError'
    this.detail = Cause === undefined ? null : String(Cause)
  }

  override toString(): string {
    return this.detail === null
      ? `${this.name}: ${this.message}`
      : `${this.name}: ${this.message} (${this.detail})`
  }
}

function ensureExpiresIn(Seconds: number): void {
  if (!Number.isInteger(Seconds) || Seconds < PRESIGN_MIN_SECONDS || Seconds > PRESIGN_MAX_SECONDS) {
    throw new ObjectStoreError(`expiresIn 需为 ${PRESIGN_MIN_SECONDS}-${PRESIGN_MAX_SECONDS} 的整数，收到: ${Seconds}`)
  }
}
