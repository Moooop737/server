/**
 * S3 兼容对象存储的实现 —— 只被 adapter/contract.ts 的 ObjectStoreHandle 调用。
 * createS3Client 把 AppConfig 的六位映射成 SDK client；其余函数只做协议调用与错误归一化。
 * get/stat 在对象不存在时返回 null；其余失败抛 ObjectStoreError，SDK 错误类型不泄出本文件。
 * ensureBucket 用 3 秒 AbortSignal 上界，避免启动时 MinIO 不可达把 serve 拖住。
 */

export { createS3Client, putObject, statObject, getObject, deleteObject, presignGet, presignPut, pingBucket, ensureBucket }
export type { S3ClientOptions }

import {
  S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand,
  DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand,
} from '@aws-sdk/client-s3'
import type { GetObjectCommandInput, PutObjectCommandInput } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Readable } from 'node:stream'
import { ObjectStoreError, ensureExpiresIn } from './object-store'
import type { ObjectStat, ObjectBody, ObjectGetOptions, ObjectPresignOptions, ObjectPresignPutOptions } from './object-store'

interface S3ClientOptions {
  endpoint: string
  region: string
  forcePathStyle: boolean
  accessKeyId: string
  secretAccessKey: string
}

function createS3Client(Options: S3ClientOptions): S3Client {
  return new S3Client({
    endpoint: Options.endpoint,
    region: Options.region,
    forcePathStyle: Options.forcePathStyle,
    credentials: {
      accessKeyId: Options.accessKeyId,
      secretAccessKey: Options.secretAccessKey,
    },
    // MinIO 不保证支持 SDK 默认附加的 CRC 校验和
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

async function putObject(
  Client: S3Client,
  Bucket: string,
  Key: string,
  Body: Uint8Array,
  ContentType: string,
): Promise<void> {
  try {
    await Client.send(new PutObjectCommand({ Bucket, Key, Body, ContentType }))
  } catch (err) {
    throw new ObjectStoreError(`put ${Key} 失败`, err)
  }
}

async function statObject(Client: S3Client, Bucket: string, Key: string): Promise<ObjectStat | null> {
  try {
    const res = await Client.send(new HeadObjectCommand({ Bucket, Key }))
    return {
      size: res.ContentLength ?? 0,
      contentType: res.ContentType ?? null,
      etag: res.ETag ?? null,
    }
  } catch (err) {
    if (isNotFound(err)) return null
    throw new ObjectStoreError(`stat ${Key} 失败`, err)
  }
}

async function getObject(
  Client: S3Client,
  Bucket: string,
  Key: string,
  Options?: ObjectGetOptions,
): Promise<ObjectBody | null> {
  const input: GetObjectCommandInput = { Bucket, Key }
  if (Options?.range !== undefined) input.Range = Options.range
  try {
    const res = await Client.send(new GetObjectCommand(input))
    if (!res.Body) throw new ObjectStoreError(`get ${Key} 响应没有 body`)
    return {
      body: res.Body as Readable,
      contentType: res.ContentType ?? null,
      contentLength: res.ContentLength ?? null,
      etag: res.ETag ?? null,
    }
  } catch (err) {
    if (isNotFound(err)) return null
    if (err instanceof ObjectStoreError) throw err
    throw new ObjectStoreError(`get ${Key} 失败`, err)
  }
}

async function deleteObject(Client: S3Client, Bucket: string, Key: string): Promise<void> {
  try {
    await Client.send(new DeleteObjectCommand({ Bucket, Key }))
  } catch (err) {
    throw new ObjectStoreError(`delete ${Key} 失败`, err)
  }
}

async function presignGet(
  Client: S3Client,
  Bucket: string,
  Key: string,
  Options: ObjectPresignOptions,
): Promise<string> {
  ensureExpiresIn(Options.expiresIn)
  const input: GetObjectCommandInput = { Bucket, Key }
  if (Options.responseContentDisposition !== undefined) {
    input.ResponseContentDisposition = Options.responseContentDisposition
  }
  if (Options.responseContentType !== undefined) {
    input.ResponseContentType = Options.responseContentType
  }
  try {
    return await getSignedUrl(Client, new GetObjectCommand(input), { expiresIn: Options.expiresIn })
  } catch (err) {
    throw new ObjectStoreError(`presign ${Key} 失败`, err)
  }
}

async function presignPut(
  Client: S3Client,
  Bucket: string,
  Key: string,
  Options: ObjectPresignPutOptions,
): Promise<string> {
  ensureExpiresIn(Options.expiresIn)
  const input: PutObjectCommandInput = { Bucket, Key }
  if (Options.contentType !== undefined) input.ContentType = Options.contentType
  try {
    return await getSignedUrl(Client, new PutObjectCommand(input), {
      expiresIn: Options.expiresIn,
      ...(Options.contentType !== undefined ? { signableHeaders: new Set(['content-type']) } : {}),
    })
  } catch (err) {
    throw new ObjectStoreError(`presignPut ${Key} 失败`, err)
  }
}

async function pingBucket(Client: S3Client, Bucket: string): Promise<void> {
  try {
    await Client.send(new HeadBucketCommand({ Bucket }), { abortSignal: AbortSignal.timeout(2000) })
  } catch (err) {
    throw new ObjectStoreError(`HeadBucket ${Bucket} 失败`, err)
  }
}

async function ensureBucket(Client: S3Client, Bucket: string): Promise<void> {
  const Signal = AbortSignal.timeout(3000)
  try {
    await Client.send(new HeadBucketCommand({ Bucket }), { abortSignal: Signal })
    return
  } catch (err) {
    if (!isNotFound(err)) throw new ObjectStoreError(`HeadBucket ${Bucket} 失败`, err)
  }
  try {
    await Client.send(new CreateBucketCommand({ Bucket }), { abortSignal: Signal })
  } catch (err) {
    if (isAlreadyExists(err)) return
    throw new ObjectStoreError(`CreateBucket ${Bucket} 失败`, err)
  }
}

function isNotFound(err: unknown): boolean {
  const Name = (err as { name?: string } | null)?.name
  const Status = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode
  return Name === 'NotFound' || Name === 'NoSuchKey' || Status === 404
}

function isAlreadyExists(err: unknown): boolean {
  const Name = (err as { name?: string } | null)?.name
  return Name === 'BucketAlreadyOwnedByYou' || Name === 'BucketAlreadyExists'
}
