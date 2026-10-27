/**
 * 真实 MinIO 集成测试 —— put/stat/get/Range/presign/delete 与错误路径。
 * 依赖 .env 的 S3_*；每个用例用独立前缀，afterAll 清对象。
 * 中间值用 peek 打到 Vitest UI 的 Console；presigned URL 只打印 host/path，不打印签名。
 */

import 'reflect-metadata'
import { afterAll, describe, expect, it } from 'vitest'
import { container } from 'tsyringe'
import { DeleteBucketCommand } from '@aws-sdk/client-s3'
import type { Readable } from 'node:stream'
import { ObjectStoreError, ObjectStoreHandle } from '../src/adapter/contract'
import { createS3Client, ensureBucket } from '../src/adapter/storage/s3'
import { AppConfig } from '../src/config'

const Store = container.resolve(ObjectStoreHandle)
const Config = container.resolve(AppConfig)
const Prefix = `test/object-store-${Date.now()}-${Math.random().toString(16).slice(2)}`
const Keys = new Set<string>()

function key(Name: string): string {
  const Key = `${Prefix}/${Name}`
  Keys.add(Key)
  return Key
}

function peek(Label: string, Value: unknown, Limit = 200): void {
  const Text = typeof Value === 'string' ? Value : JSON.stringify(Value)
  console.log(`[peek] ${Label}:`, Text.length > Limit ? `${Text.slice(0, Limit)}…` : Text)
}

async function readAll(Body: Readable): Promise<Buffer> {
  const Chunks: Buffer[] = []
  for await (const Chunk of Body) Chunks.push(Buffer.from(Chunk as Uint8Array))
  return Buffer.concat(Chunks)
}

afterAll(async () => {
  for (const Key of Keys) {
    await Store.delete(Key).catch(() => undefined)
  }
})

describe('ObjectStore（真实 MinIO）', () => {
  it('ensureBucket 幂等', async () => {
    await expect(Store.ensureBucket()).resolves.toBeUndefined()
    await expect(Store.ensureBucket()).resolves.toBeUndefined()
  })

  it('ensureBucket 能创建不存在的临时桶，再调一次仍成功', async () => {
    const TempBucket = `test-bucket-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const Client = createS3Client({
      endpoint: Config.s3Endpoint,
      region: Config.s3Region,
      forcePathStyle: Config.s3ForcePathStyle,
      accessKeyId: Config.s3AccessKeyId,
      secretAccessKey: Config.s3SecretAccessKey,
    })
    peek('temp bucket', TempBucket)
    try {
      await ensureBucket(Client, TempBucket)
      await expect(ensureBucket(Client, TempBucket)).resolves.toBeUndefined()
    } finally {
      await Client.send(new DeleteBucketCommand({ Bucket: TempBucket })).catch(() => undefined)
    }
  }, 15_000)

  it('put → stat → get → delete', async () => {
    const Key = key('roundtrip.txt')
    const Body = Buffer.from('storage adapter\n')
    await Store.put(Key, Body, 'text/plain')
    const Stat = await Store.stat(Key)
    peek('stat', Stat)
    expect(Stat).not.toBeNull()
    expect(Stat?.size).toBe(Body.length)
    expect(Stat?.contentType).toBe('text/plain')
    expect(Stat?.etag).toBeTruthy()

    const Got = await Store.get(Key)
    expect(Got).not.toBeNull()
    expect(Got?.contentType).toBe('text/plain')
    expect(await readAll(Got!.body)).toEqual(Body)

    await Store.delete(Key)
    expect(await Store.stat(Key)).toBeNull()
  })

  it('Range 只返回请求的字节', async () => {
    const Key = key('range.txt')
    await Store.put(Key, Buffer.from('0123456789'), 'text/plain')
    const Got = await Store.get(Key, { range: 'bytes=2-5' })
    expect(Got).not.toBeNull()
    expect(Got?.contentLength).toBe(4)
    expect(await readAll(Got!.body)).toEqual(Buffer.from('2345'))
    await Store.delete(Key)
  })

  it('presignGet 返回可下载的 URL 与 attachment/nosniff', async () => {
    const Key = key('presign.txt')
    const Body = Buffer.from('presigned body\n')
    await Store.put(Key, Body, 'text/plain')
    const Url = await Store.presignGet(Key, {
      expiresIn: 60,
      responseContentDisposition: 'attachment; filename="presign.txt"',
    })
    const Parsed = new URL(Url)
    expect(Parsed.host).toBe(new URL(Config.s3Endpoint).host)
    expect(Parsed.pathname).toBe(`/${Config.s3Bucket}/${Key}`)
    peek('presign', {
      host: Parsed.host,
      pathname: Parsed.pathname,
      hasSignature: Parsed.searchParams.has('X-Amz-Signature'),
    })

    const Res = await fetch(Url)
    peek('presign response', {
      status: Res.status,
      disposition: Res.headers.get('content-disposition'),
      nosniff: Res.headers.get('x-content-type-options'),
    })
    expect(Res.status).toBe(200)
    expect(Res.headers.get('content-disposition')).toContain('attachment')
    expect(Res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await Res.arrayBuffer())).toEqual(Body)
    await Store.delete(Key)
  })

  it('presignPut 可直传，Content-Type 被签', async () => {
    const Key = key('upload.txt')
    const Url = await Store.presignPut(Key, { expiresIn: 60, contentType: 'text/plain' })
    const Parsed = new URL(Url)
    peek('presignPut', {
      host: Parsed.host,
      pathname: Parsed.pathname,
      signedHeaders: Parsed.searchParams.get('X-Amz-SignedHeaders'),
    })
    expect(Parsed.host).toBe(new URL(Config.s3Endpoint).host)
    expect(Parsed.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type')

    const Body = Buffer.from('uploaded via presigned put\n')
    const Res = await fetch(Url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: Body,
    })
    peek('presignPut response', { status: Res.status })
    expect(Res.status).toBe(200)

    const Got = await Store.get(Key)
    expect(await readAll(Got!.body)).toEqual(Body)
    expect((await Store.stat(Key))?.contentType).toBe('text/plain')
    await Store.delete(Key)
  })

  it('presignPut 的 Content-Type 不匹配 → 403', async () => {
    const Key = key('upload-mismatch.txt')
    const Url = await Store.presignPut(Key, { expiresIn: 60, contentType: 'text/plain' })
    const Res = await fetch(Url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from('{"x":1}'),
    })
    peek('presignPut mismatch', { status: Res.status })
    expect(Res.status).toBe(403)
  })

  it('presign 过期后返回 403', async () => {
    const Key = key('expire.txt')
    await Store.put(Key, Buffer.from('x'), 'text/plain')
    const Url = await Store.presignGet(Key, { expiresIn: 1 })
    await new Promise((Resolve) => setTimeout(Resolve, 2000))
    const Res = await fetch(Url)
    peek('expired response', { status: Res.status })
    expect(Res.status).toBe(403)
    await Store.delete(Key)
  }, 10_000)

  it('不存在的对象 stat/get 返回 null，delete 幂等', async () => {
    const Key = key('missing.txt')
    expect(await Store.stat(Key)).toBeNull()
    expect(await Store.get(Key)).toBeNull()
    await expect(Store.delete(Key)).resolves.toBeUndefined()
  })

  it('非法 expiresIn 抛 ObjectStoreError', async () => {
    await expect(Store.presignGet('whatever', { expiresIn: 0 })).rejects.toBeInstanceOf(ObjectStoreError)
    await expect(Store.presignGet('whatever', { expiresIn: 604801 })).rejects.toBeInstanceOf(ObjectStoreError)
    await expect(Store.presignPut('whatever', { expiresIn: 0 })).rejects.toBeInstanceOf(ObjectStoreError)
    await expect(Store.presignPut('whatever', { expiresIn: 604801 })).rejects.toBeInstanceOf(ObjectStoreError)
  })
})
