/**
 * 已归档资源的抓取器 —— 按 ctx.data.data_uri 从对象存储读原始内容，塞进 ctx.fetched。
 * 不发网络请求；data_uri 必须是当前桶的 kc://oss/minio/<bucket>/<key>，bucket 不匹配直接抛。
 * 对象不存在抛 code='E_NO_ORIGINAL'；正文按 UTF-8 解码，content_type 优先用对象元数据。
 * 同一份 Buffer 上复算 SHA-256 放进 fetched.sha256，供 ingest 比对归档时声明的 hash。
 */

import type { Fetcher, IngestContext } from '../contracts'
import type { ObjectStore } from '../../adapter/contract'
import { sha256Hex } from '../../adapter/storage/hash'
import { parseDataUri } from '../../adapter/storage/uri'

export class StorageFetcher implements Fetcher {
  readonly name = 'storage'
  private readonly store: ObjectStore
  private readonly bucket: string

  constructor(Store: ObjectStore, Bucket: string) {
    this.store = Store
    this.bucket = Bucket
  }

  async run(ctx: IngestContext): Promise<void> {
    const dataUri = ctx.data.data_uri
    if (!dataUri) throw new Error('缺少 data_uri')
    const parts = parseDataUri(dataUri)
    if (parts.bucket !== this.bucket) throw new Error(`data_uri bucket 不匹配: ${parts.bucket}`)

    const object = await this.store.get(parts.key)
    if (!object) throw Object.assign(new Error('原始对象不存在'), { code: 'E_NO_ORIGINAL' })

    const chunks: Buffer[] = []
    for await (const chunk of object.body) chunks.push(Buffer.from(chunk as Uint8Array))
    const bytes = Buffer.concat(chunks)
    ctx.fetched = {
      raw: bytes.toString('utf8'),
      content_type: object.contentType ?? ctx.data.content_type,
      final_url: dataUri,
      sha256: sha256Hex(bytes),
    }
  }
}
