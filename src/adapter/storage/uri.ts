/**
 * data_uri 编解码与对象 key 生成 —— kc://oss/minio/<bucket>/<key>。
 * build/parse 成对：只认 minio，bucket 非空，key 是无 . / .. 的相对路径；非法一律 StorageUriError。
 * keyForUpload/keyForUrl/keyForPaste 只生成人类可读的基础 key；同名冲突由 allocateKey 通过调用方传入的 IsTaken 解决。
 * 本文件不访问网络或数据库。
 */

export {
  buildDataUri, parseDataUri, sanitizeKeyPath, keyForUpload, keyForUrl, keyForPaste, keyForCodebase, fileNameFromKey,
  keyWithSuffix, allocateKey, mimeFromKey, extForMime, StorageUriError,
}
export type { DataUriParts, KeyTaken, AllocateOptions, StorageUriErrorCode }

import { randomBytes } from 'node:crypto'

interface DataUriParts {
  backend: 'minio'
  bucket: string
  key: string
}

type KeyTaken = (Key: string) => boolean | Promise<boolean>

interface AllocateOptions {
  maxAttempts?: number
  token?: string
}

type StorageUriErrorCode = 'E_BAD_URI' | 'E_BAD_PATH' | 'E_BAD_MIME' | 'E_KEY_ALLOC'

class StorageUriError extends Error {
  readonly code: StorageUriErrorCode

  constructor(Code: StorageUriErrorCode, Message: string) {
    super(Message)
    this.name = 'StorageUriError'
    this.code = Code
  }
}

const DATA_URI_PREFIX = 'kc://oss/'
const BACKEND = 'minio'
const MAX_KEY_BYTES = 900
const MAX_SEGMENT_CHARS = 160
const DEFAULT_MAX_ATTEMPTS = 8
const MIME_BY_EXT = new Map<string, string>([
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.txt', 'text/plain'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
])
const EXT_BY_MIME = new Map<string, string>([
  ['text/markdown', '.md'],
  ['text/plain', '.txt'],
  ['text/html', '.html'],
])

function buildDataUri(Bucket: string, Key: string): string {
  assertBucket(Bucket)
  const segments = splitKey(Key)
  return `${DATA_URI_PREFIX}${BACKEND}/${encodeURIComponent(Bucket)}/${segments.map(encodeURIComponent).join('/')}`
}

function parseDataUri(Uri: string): DataUriParts {
  if (!Uri.startsWith(DATA_URI_PREFIX)) {
    throw new StorageUriError('E_BAD_URI', `data_uri 必须以 ${DATA_URI_PREFIX} 开头: ${Uri}`)
  }
  const rest = Uri.slice(DATA_URI_PREFIX.length)
  const backendEnd = rest.indexOf('/')
  if (backendEnd <= 0) throw new StorageUriError('E_BAD_URI', `data_uri 缺少后端或 bucket: ${Uri}`)
  const backend = rest.slice(0, backendEnd)
  if (backend !== BACKEND) {
    throw new StorageUriError('E_BAD_URI', `data_uri 后端必须是 ${BACKEND}: ${Uri}`)
  }
  const afterBackend = rest.slice(backendEnd + 1)
  const bucketEnd = afterBackend.indexOf('/')
  if (bucketEnd <= 0 || bucketEnd === afterBackend.length - 1) {
    throw new StorageUriError('E_BAD_URI', `data_uri 缺少 bucket 或 key: ${Uri}`)
  }
  const bucket = decodeSegment(afterBackend.slice(0, bucketEnd), Uri)
  const keyPart = afterBackend.slice(bucketEnd + 1)
  const segments = keyPart.split('/').map((Segment) => decodeSegment(Segment, Uri))
  validateSegments(segments, Uri)
  return { backend: BACKEND, bucket, key: segments.join('/') }
}

function sanitizeKeyPath(Input: string): string {
  const normalized = Input.replace(/\\/g, '/')
  const segments = normalized
    .split('/')
    .map((Segment) => Segment.trim())
    .filter((Segment) => Segment !== '')
    .map((Segment) => sanitizeSegment(Segment))
  validateSegments(segments, Input)
  return segments.join('/')
}

function keyForUpload(Path: string): string {
  return sanitizeKeyPath(Path)
}

function keyForUrl(Url: string): string {
  let parsed: URL
  try {
    parsed = new URL(Url)
  } catch {
    throw new StorageUriError('E_BAD_PATH', `URL 不合法: ${Url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new StorageUriError('E_BAD_PATH', `仅支持 http/https: ${Url}`)
  }
  let path: string
  try {
    path = decodeURIComponent(parsed.pathname)
  } catch {
    throw new StorageUriError('E_BAD_PATH', `URL 路径编码不合法: ${Url}`)
  }
  const withIndex = path.endsWith('/') ? `${path}index` : path
  return sanitizeKeyPath(`${parsed.host}/${withIndex}`)
}

function keyForPaste(Title: string, Mime: string): string {
  const mime = Mime.toLowerCase()
  if (mime !== 'text/markdown' && mime !== 'text/plain') {
    throw new StorageUriError('E_BAD_MIME', `粘贴只支持 text/markdown 或 text/plain，收到: ${Mime}`)
  }
  return `${slugify(Title)}${extForMime(mime)!}`
}

function keyForCodebase(Filename: string): string {
  const name = Filename.trim()
  if (name === '' || name.includes('/') || name.includes('\\')) {
    throw new StorageUriError('E_BAD_PATH', `代码库文件名不能为空或包含路径: ${Filename}`)
  }
  if (!/\.zip$/i.test(name)) {
    throw new StorageUriError('E_BAD_PATH', `代码库只支持 .zip: ${Filename}`)
  }
  return sanitizeKeyPath(`codebases/${name}`)
}

function keyWithSuffix(Key: string, Token: string, Attempt = 1): string {
  const base = sanitizeKeyPath(Key)
  if (!/^[a-z0-9]{4,16}$/.test(Token)) {
    throw new StorageUriError('E_BAD_PATH', `冲突后缀必须是 4-16 位小写字母或数字: ${Token}`)
  }
  if (!Number.isInteger(Attempt) || Attempt < 1) {
    throw new StorageUriError('E_BAD_PATH', `冲突次数必须是正整数: ${Attempt}`)
  }
  const slash = base.lastIndexOf('/')
  const dir = slash >= 0 ? base.slice(0, slash + 1) : ''
  const name = base.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const suffix = Attempt === 1 ? Token : `${Token}-${Attempt}`
  return `${dir}${stem}-${suffix}${ext}`
}

async function allocateKey(
  BaseKey: string,
  IsTaken: KeyTaken,
  Options: AllocateOptions = {},
): Promise<string> {
  const base = sanitizeKeyPath(BaseKey)
  const maxAttempts = Options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 32) {
    throw new StorageUriError('E_BAD_PATH', `maxAttempts 需为 1-32 的整数: ${maxAttempts}`)
  }
  const token = Options.token ?? randomToken()
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = attempt === 0 ? base : keyWithSuffix(base, token, attempt)
    if (!(await IsTaken(key))) return key
  }
  throw new StorageUriError('E_KEY_ALLOC', `尝试 ${maxAttempts} 次仍无法分配唯一 key: ${base}`)
}

function fileNameFromKey(Key: string): string {
  const slash = Key.lastIndexOf('/')
  return slash >= 0 ? Key.slice(slash + 1) : Key
}

function mimeFromKey(Key: string): string | null {
  const name = fileNameFromKey(Key)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return MIME_BY_EXT.get(name.slice(dot).toLowerCase()) ?? null
}

function extForMime(Mime: string): string | null {
  return EXT_BY_MIME.get(Mime.toLowerCase()) ?? null
}

function assertBucket(Bucket: string): void {
  if (Bucket === '' || Bucket.includes('/') || Bucket.includes('\\') || hasControl(Bucket)) {
    throw new StorageUriError('E_BAD_URI', `bucket 不合法: ${Bucket}`)
  }
}

function splitKey(Key: string): string[] {
  const segments = Key.replace(/\\/g, '/')
    .split('/')
    .filter((Segment) => Segment !== '')
    .map((Segment) => Segment.trim())
  validateSegments(segments, Key)
  return segments
}

function sanitizeSegment(Segment: string): string {
  if (Segment === '' || Segment === '.' || Segment === '..') {
    throw new StorageUriError('E_BAD_PATH', `路径段不合法: ${Segment}`)
  }
  if (Segment.includes('/') || Segment.includes('\\') || hasControl(Segment)) {
    throw new StorageUriError('E_BAD_PATH', `路径段含非法字符: ${Segment}`)
  }
  if (Array.from(Segment).length > MAX_SEGMENT_CHARS) {
    throw new StorageUriError('E_BAD_PATH', `路径段超过 ${MAX_SEGMENT_CHARS} 字符: ${Segment}`)
  }
  return Segment
}

function validateSegments(Segments: string[], Source: string): void {
  if (Segments.length === 0) throw new StorageUriError('E_BAD_PATH', `路径为空: ${Source}`)
  if (Buffer.byteLength(Segments.join('/'), 'utf8') > MAX_KEY_BYTES) {
    throw new StorageUriError('E_BAD_PATH', `路径超过 ${MAX_KEY_BYTES} 字节: ${Source}`)
  }
  for (const Segment of Segments) sanitizeSegment(Segment)
}

function decodeSegment(Segment: string, Source: string): string {
  if (Segment === '') throw new StorageUriError('E_BAD_URI', `data_uri 含空路径段: ${Source}`)
  let decoded: string
  try {
    decoded = decodeURIComponent(Segment)
  } catch {
    throw new StorageUriError('E_BAD_URI', `data_uri 路径编码不合法: ${Source}`)
  }
  if (decoded.includes('/') || decoded.includes('\\') || hasControl(decoded)) {
    throw new StorageUriError('E_BAD_URI', `data_uri 路径段含非法字符: ${Source}`)
  }
  if (decoded === '.' || decoded === '..') {
    throw new StorageUriError('E_BAD_URI', `data_uri 不允许 . 或 .. 路径段: ${Source}`)
  }
  return decoded
}

function slugify(Title: string): string {
  const slug = Title
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const limited = Array.from(slug).slice(0, 80).join('')
  return limited === '' ? 'paste' : limited
}

function hasControl(Text: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(Text)
}

function randomToken(): string {
  return randomBytes(4).toString('hex')
}
