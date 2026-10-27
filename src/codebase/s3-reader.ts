/**
 * yauzl 的 S3 随机读适配器 —— 中央目录的小块读取走 1MB 块缓存，条目正文走单次 Range GET。
 * yauzl 每读一条中央目录记录会调用一次 read()（46 字节）；不带缓存时 1000 条目就是 1000 次 S3 请求。
 * _readStreamForRange 的 end 是排他边界；S3 Range 头是闭区间，所以发 bytes=start-(end-1)。
 */

export { S3ZipReader }

import { PassThrough } from 'node:stream'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { RandomAccessReader } from 'yauzl'
import type { ObjectStore } from '../adapter/contract'

const BLOCK_SIZE = 1024 * 1024
const MAX_CACHED_BLOCKS = 16

class S3ZipReader extends RandomAccessReader {
  private readonly store: ObjectStore
  private readonly key: string
  private readonly size: number
  private readonly blocks = new Map<number, Promise<Buffer>>()

  constructor(Store: ObjectStore, Key: string, Size: number) {
    super()
    this.store = Store
    this.key = Key
    this.size = Size
  }

  read(BufferOut: Buffer, Offset: number, Length: number, Position: number, Callback: (Err: Error | null) => void): void {
    void this.readBytes(Position, Length)
      .then((Bytes) => {
        if (Bytes.length !== Length) {
          Callback(new Error(`ZIP 读取长度不足: ${Bytes.length}/${Length} @ ${Position}`))
          return
        }
        Bytes.copy(BufferOut, Offset)
        Callback(null)
      })
      .catch((Err) => Callback(Err instanceof Error ? Err : new Error(String(Err))))
  }

  _readStreamForRange(Start: number, End: number): Readable {
    const Out = new PassThrough()
    const From = Math.max(0, Start)
    const To = Math.min(End, this.size)
    if (To <= From) {
      Out.end()
      return Out
    }
    void (async () => {
      const object = await this.store.get(this.key, { range: `bytes=${From}-${To - 1}` })
      if (!object) throw new Error('ZIP 对象不存在')
      await pipeline(object.body, Out)
    })().catch((Err) => Out.destroy(Err instanceof Error ? Err : new Error(String(Err))))
    return Out
  }

  close(Callback: (Err: Error | null) => void): void {
    this.blocks.clear()
    Callback(null)
  }

  private async readBytes(Position: number, Length: number): Promise<Buffer> {
    if (Length <= 0) return Buffer.alloc(0)
    if (Position >= this.size) return Buffer.alloc(0)
    if (Length > BLOCK_SIZE) return this.fetchRange(Position, Math.min(Length, this.size - Position))

    const First = Math.floor(Position / BLOCK_SIZE)
    const Last = Math.floor((Position + Length - 1) / BLOCK_SIZE)
    const Parts: Buffer[] = []
    for (let BlockIndex = First; BlockIndex <= Last; BlockIndex += 1) {
      const Block = await this.block(BlockIndex)
      const Start = BlockIndex === First ? Position - BlockIndex * BLOCK_SIZE : 0
      const End = BlockIndex === Last ? Position + Length - BlockIndex * BLOCK_SIZE : Block.length
      Parts.push(Block.subarray(Start, Math.min(End, Block.length)))
    }
    return Buffer.concat(Parts)
  }

  private block(Index: number): Promise<Buffer> {
    const Cached = this.blocks.get(Index)
    if (Cached) return Cached

    const Start = Index * BLOCK_SIZE
    if (Start >= this.size) return Promise.resolve(Buffer.alloc(0))
    const End = Math.min(Start + BLOCK_SIZE, this.size)
    const Pending = this.fetchRange(Start, End - Start).catch((Err) => {
      this.blocks.delete(Index)
      throw Err
    })
    this.blocks.set(Index, Pending)
    while (this.blocks.size > MAX_CACHED_BLOCKS) {
      const Oldest = this.blocks.keys().next().value
      if (Oldest === undefined) break
      this.blocks.delete(Oldest)
    }
    return Pending
  }

  private async fetchRange(Start: number, Length: number): Promise<Buffer> {
    const object = await this.store.get(this.key, { range: `bytes=${Start}-${Start + Length - 1}` })
    if (!object) throw new Error('ZIP 对象不存在')
    const Chunks: Buffer[] = []
    for await (const Chunk of object.body) Chunks.push(Buffer.from(Chunk as Uint8Array))
    return Buffer.concat(Chunks)
  }
}
