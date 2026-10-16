import { test } from 'node:test'
import assert from 'node:assert/strict'
import { legacySplit, splitBySeparators } from './legacy'
import { resolveChunkerConfig } from './config'
import { protectedSpans } from './protected'
import { CODE_BLOCK, makeDoc, TABLE } from './legacy.fixtures'

// ── 1. 15 字符小例子：逐块内容和下标都要等于设计时手推的那张表 ──

test('legacySplit 小例子 = 4 块，重叠落在段落界和句界上', () => {
  const text = 'aa。bb\n\ncc。dd。ee' // 15 字符
  const cfg = resolveChunkerConfig({ chunkSize: 6, chunkOverlap: 5 }) // overlap 应被钳到 3

  assert.equal(cfg.chunkOverlap, 3, 'overlap 5 应被钳到 chunkSize/2 = 3')

  const got = legacySplit(text, cfg)
  assert.deepEqual(
    got.map((c) => [c.content, c.start_offset, c.end_offset]),
    [
      ['aa。bb', 0, 5],
      ['bb\n\ncc', 3, 9],
      ['cc。dd。', 7, 13],
      ['dd。ee', 10, 15],
    ],
  )
  assert.deepEqual(got.map((c) => c.chunk_index), [0, 1, 2, 3])
  assert.ok(got.every((c) => c.strategy === 'legacy'))
})

// ── 2. 递归切分：分隔符按优先级下钻，且拼回去 == 原文 ──

test('splitBySeparators 下钻只降级到低优先级，不无限递归', () => {
  const seps = ['\n\n', '\n', '。']
  const text = 'aa。bb\n\ncc。dd。ee'

  assert.deepEqual(splitBySeparators(text, seps, 6), ['aa。bb', '\n\n', 'cc', '。', 'dd', '。', 'ee'])
  assert.equal(splitBySeparators(text, seps, 6).join('').length, text.length, '单元拼回必须等于原文')
  // 分隔符用尽仍超长 → 原样返回，不递归爆栈
  assert.deepEqual(splitBySeparators('xxxxxx', seps, 3), ['xxxxxx'])
})

// ── 3~6. 真实文档上的核心不变量 ──

test('文档分块：slice 不变量 / 不超绝对上限 / 重叠是前后块的公共段', () => {
  const doc = makeDoc()
  const cfg = resolveChunkerConfig({}) // 默认 512/80
  const chunks = legacySplit(doc, cfg)

  assert.ok(chunks.length > 1, '这篇文档应该切出多块')

  for (const c of chunks) {
    // ① 唯一的硬不变量：位置能精确取回内容
    assert.equal(doc.slice(c.start_offset, c.end_offset), c.content, `块 ${c.chunk_index} 位置与内容不符`)
    // ② 长度：绝不超过绝对上限
    assert.ok(c.content.length <= 7500, `块 ${c.chunk_index} 超过绝对上限`)
    // ③ 不产出空白块（否则白占一条向量），且区间不退化
    assert.ok(c.content.trim() !== '', `块 ${c.chunk_index} 是空白块`)
    assert.ok(c.start_offset < c.end_offset, `块 ${c.chunk_index} 区间退化`)
  }

  assert.ok(chunks.length >= 4, `文档应该切出至少 4 块，实际 ${chunks.length}`)

  const lens = chunks.map((c) => c.content.length)
  let overlapSeen = 0
  for (let i = 0; i + 1 < chunks.length; i++) {
    const prev = chunks[i]
    const next = chunks[i + 1]
    if (!prev || !next) continue
    assert.ok(next.start_offset >= prev.start_offset, '块应按原文顺序输出')
    const overlapLen = prev.end_offset - next.start_offset
    if (overlapLen > 0) {
      overlapSeen++
      // ④ 重叠区必须既是上一块的尾巴、又是下一块的开头
      const shared = doc.slice(next.start_offset, prev.end_offset)
      assert.ok(prev.content.endsWith(shared), `块${i}/块${i + 1} 重叠不是上一块尾巴`)
      assert.ok(next.content.startsWith(shared), `块${i}/块${i + 1} 重叠不是下一块开头`)
      assert.ok(shared.length <= cfg.chunkOverlap, '重叠长度不得超预算')
    }
  }
  // 重叠路径必须在真实文档上被压到，不能只由小例子覆盖
  assert.ok(overlapSeen > 0, '一次重叠都没发生')

  console.log(
    `  分块数=${chunks.length} 重叠对数=${overlapSeen} 长度=[${lens.join(', ')}] 平均=${Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)} (chunkSize=${cfg.chunkSize})`,
  )
})

test('保护段不被拦腰切断：每个保护段完整落在某一块内', () => {
  const doc = makeDoc()
  const chunks = legacySplit(doc, resolveChunkerConfig({}))
  const spans = protectedSpans(doc)

  assert.ok(spans.length >= 5, `应该识别出多个保护段，实际 ${spans.length}`)

  for (const s of spans) {
    const covered = chunks.some((c) => c.start_offset <= s.start && s.end <= c.end_offset)
    assert.ok(
      covered,
      `保护段 [${s.start},${s.end}) 被切断了：${JSON.stringify(doc.slice(s.start, s.end).slice(0, 40))}`,
    )
  }
})

test('代码块和表格行原样留在同一块里', () => {
  const doc = makeDoc()
  const chunks = legacySplit(doc, resolveChunkerConfig({}))
  const contents = chunks.map((c) => c.content)

  // 整个围栏代码块（含首尾 ```）必须在同一块
  assert.ok(
    contents.some((t) => t.includes(CODE_BLOCK)),
    '围栏代码块被切开了',
  )
  // 表格每一行必须整行出现，不能被切成半行
  for (const line of TABLE.split('\n')) {
    assert.ok(contents.some((t) => t.includes(line)), `表格行被切断：${line}`)
  }
})

// ── 7. 空正文 = 0 块（Story 1.2 AC「0 Chunk → 失败(内容为空)」）──

test('空正文与纯空白都返回 0 块', () => {
  const cfg = resolveChunkerConfig({})
  assert.deepEqual(legacySplit('', cfg), [])
  assert.deepEqual(legacySplit('   \n\n  \t ', cfg), [])
})

// ── 8. 诚实记录一个取舍：没有分隔符的超长段落不拦腰切 ──

test('单段 700 字符无任何分隔符 → 一整块（宁可超 chunkSize 也不切碎段落）', () => {
  const para = '长'.repeat(700)
  const chunks = legacySplit(para, resolveChunkerConfig({ chunkSize: 512 }))
  const only = chunks[0]
  assert.equal(chunks.length, 1)
  assert.ok(only)
  assert.equal(only.content.length, 700)
  assert.equal(only.end_offset, 700)
})
