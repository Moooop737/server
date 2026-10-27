/**
 * ZIP 中央目录检查 —— 只读条目元数据，不解压正文、不写条目文件、不执行仓库内容。
 * 读的是上传到 MinIO 的原始 ZIP 的临时副本；返回扁平清单，树由 path 合成。
 * 路径策略、特殊文件、重名、加密与不可解码条目都在这里拒绝；默认忽略 .git / node_modules / dist / build。
 */

export { inspectZip, ZipError }
export type { ZipEntryRecord, ZipInspection }

import { openPromise } from 'yauzl'
import type { Entry, ZipFile } from 'yauzl'

type ZipErrorCode =
  | 'E_ZIP_INVALID'
  | 'E_ZIP_PATH'
  | 'E_ZIP_SYMLINK'
  | 'E_ZIP_SPECIAL'
  | 'E_ZIP_ENCRYPTED'
  | 'E_ZIP_UNSUPPORTED'
  | 'E_ZIP_DUPLICATE'
  | 'E_ZIP_EMPTY'

interface ZipEntryRecord {
  path: string
  entry_index: number
  is_dir: boolean
  compressed_size: number
  uncompressed_size: number
  compression_method: number
}

interface ZipInspection {
  manifest: ZipEntryRecord[]
  fileCount: number
  declaredUncompressedBytes: number
}

class ZipError extends Error {
  readonly code: ZipErrorCode

  constructor(Code: ZipErrorCode, Message: string) {
    super(Message)
    this.name = 'ZipError'
    this.code = Code
  }
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build'])
const UNIX_TYPE_MASK = 0o170000
const UNIX_REGULAR = 0o100000
const UNIX_DIRECTORY = 0o040000
const UNIX_SYMLINK = 0o120000

async function inspectZip(FilePath: string): Promise<ZipInspection> {
  let zip: ZipFile
  try {
    zip = await openPromise(FilePath, { lazyEntries: true, autoClose: false, validateEntrySizes: false, strictFileNames: true })
  } catch (err) {
    throw classifyZipError(err, 'ZIP 无法读取')
  }

  const Manifest: ZipEntryRecord[] = []
  const Seen = new Set<string>()
  let FileCount = 0
  let DeclaredBytes = 0
  let Index = 0

  try {
    for await (const entry of zip.eachEntry()) {
      const Current = Index
      Index += 1
      if (entry.isEncrypted()) throw new ZipError('E_ZIP_ENCRYPTED', `ZIP 条目已加密: ${entry.fileName}`)
      if (!entry.canDecodeFileData()) throw new ZipError('E_ZIP_UNSUPPORTED', `ZIP 条目压缩方式不支持: ${entry.fileName}`)

      const Kind = entryKind(entry)
      if (Kind === 'symlink') throw new ZipError('E_ZIP_SYMLINK', `ZIP 含符号链接: ${entry.fileName}`)
      if (Kind === 'special') throw new ZipError('E_ZIP_SPECIAL', `ZIP 含设备/管道等特殊文件: ${entry.fileName}`)
      const IsDir = Kind === 'dir'
      const Path = normalizeEntryPath(entry.fileName, IsDir)
      const Segments = Path.split('/')
      if (Segments.some((Segment) => IGNORED_DIRS.has(Segment))) continue

      if (Seen.has(Path)) throw new ZipError('E_ZIP_DUPLICATE', `ZIP 含重名条目: ${Path}`)
      Seen.add(Path)

      if (!Number.isSafeInteger(entry.compressedSize) || !Number.isSafeInteger(entry.uncompressedSize)) {
        throw new ZipError('E_ZIP_INVALID', `ZIP 条目大小超出安全整数: ${Path}`)
      }
      Manifest.push({
        path: Path,
        entry_index: Current,
        is_dir: IsDir,
        compressed_size: entry.compressedSize,
        uncompressed_size: entry.uncompressedSize,
        compression_method: entry.compressionMethod,
      })
      if (!IsDir) {
        FileCount += 1
        DeclaredBytes += entry.uncompressedSize
      }
    }
  } catch (err) {
    if (err instanceof ZipError) throw err
    throw classifyZipError(err, 'ZIP 解析失败')
  } finally {
    zip.close()
  }

  if (FileCount === 0) throw new ZipError('E_ZIP_EMPTY', 'ZIP 里没有可用文件')
  return { manifest: Manifest, fileCount: FileCount, declaredUncompressedBytes: DeclaredBytes }
}

function entryKind(Entry: Entry): 'file' | 'dir' | 'symlink' | 'special' {
  const UnixType = (Entry.externalFileAttributes >>> 16) & UNIX_TYPE_MASK
  if (UnixType === UNIX_SYMLINK) return 'symlink'
  if (UnixType === UNIX_DIRECTORY) return 'dir'
  if (UnixType === UNIX_REGULAR) return 'file'
  if (UnixType === 0) return Entry.fileName.endsWith('/') || (Entry.externalFileAttributes & 0x10) !== 0 ? 'dir' : 'file'
  return 'special'
}

function normalizeEntryPath(Raw: string, IsDir: boolean): string {
  if (Raw === '' || Raw.includes('\\')) throw new ZipError('E_ZIP_PATH', `ZIP 路径含反斜杠或为空: ${Raw}`)
  if (Raw.startsWith('/') || /^[A-Za-z]:/.test(Raw)) throw new ZipError('E_ZIP_PATH', `ZIP 路径不能是绝对路径: ${Raw}`)
  if (/[\u0000-\u001f\u007f]/.test(Raw)) throw new ZipError('E_ZIP_PATH', `ZIP 路径含控制字符: ${Raw}`)

  const Trimmed = IsDir && Raw.endsWith('/') ? Raw.slice(0, -1) : Raw
  const Segments = Trimmed.split('/')
  if (Segments.length === 0 || Segments.some((Segment) => Segment === '' || Segment === '.' || Segment === '..')) {
    throw new ZipError('E_ZIP_PATH', `ZIP 路径含空段、. 或 ..: ${Raw}`)
  }
  return Segments.join('/')
}

function classifyZipError(Err: unknown, Prefix: string): ZipError {
  const Message = errMessage(Err)
  if (/invalid relative path|absolute path|backslash|invalid characters/i.test(Message)) {
    return new ZipError('E_ZIP_PATH', `${Prefix}: ${Message}`)
  }
  return new ZipError('E_ZIP_INVALID', `${Prefix}: ${Message}`)
}

function errMessage(Err: unknown): string {
  return Err instanceof Error ? Err.message : String(Err)
}
