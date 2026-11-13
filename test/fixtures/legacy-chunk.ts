// 分块测试/预览共用的文档。含表格、围栏代码、行内代码、链接、连续段落。

export const CODE_BLOCK = [
  '```ts',
  'export function add(a: number, b: number): number {',
  '  return a + b // 求和',
  '}',
  '```',
].join('\n')

export const TABLE = [
  '| 名称 | 维度 | 说明 |',
  '| --- | --- | --- |',
  '| halfvec | 1024 | 半精度向量列 |',
  '| bm25 | 不适用 | 中文分词走 chinese_lindera |',
  '| dimension | 不适用 | 必须等于向量真实长度 |',
].join('\n')

export function makeDoc(): string {
  const para = (n: number) =>
    `第 ${n} 节讲检索链路里的一个环节：为什么偏移量必须一路带到引用层，为什么低于下限要拒答，以及适配器为什么要如实写维度。`
  const prose = Array.from({ length: 14 }, (_, k) => para(k + 1))

  return [
    prose[0] ?? '',
    '',
    '先看一个最小的实现片段，它定义了装箱时用的加法语义：',
    '',
    CODE_BLOCK,
    '',
    '接着是字段对照表，注意 `dimension` 这一列必须由适配器如实写入。',
    '',
    TABLE,
    '',
    '相似度用行内码 `halfvec_cosine_ops` 表示，走的是方向而非距离，所以 MRL 截断后不必再归一化。',
    '',
    ...prose.slice(1, 8),
    '',
    '混合检索把向量和 BM25 的结果合并，参见 [WeKnora 的实现](https://github.com/Tencent/WeKnora)。',
    '低于相关性下限的结果视同未命中，此时应当拒答而不是编造答案。',
    '',
    ...prose.slice(8),
    '',
    '最后是一段很长的文本，用来观察装箱在段落之间怎么留重叠。'.repeat(6),
  ].join('\n')
}
