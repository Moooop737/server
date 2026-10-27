/**
 * Langfuse 读侧的边界：URL 带 traceId/fields、Basic 鉴权、cursor 翻页、input/output 解析、
 * 401/429 与坏形状映射成稳定的 LangfuseReadError；空 data 是导出延迟，不报错。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LangfuseReadError, langfuseReady, readLangfuseObservations } from './read'

const Observation = {
  id: 'obs-1',
  traceId: 'lf-trace-1',
  parentObservationId: null,
  type: 'GENERATION',
  name: 'chat',
  startTime: '2026-10-22T09:00:00.000Z',
  endTime: '2026-10-22T09:00:01.200Z',
  latency: 1.2,
  timeToFirstToken: 0.4,
  model: 'deepseek-flash',
  isRootObservation: true,
  input: '{"messages":[{"role":"user","content":"hi"}]}',
  output: '[{"type":"text","text":"hello"}]',
  usageDetails: { input: 10, output: 4, total: 14 },
  totalCost: 0.001,
  tags: ['chat'],
  traceName: 'chat',
  metadata: { 'attributes.gen_ai.tool.call.id': 'call_1' },
}

function jsonResponse(Body: unknown, Status = 200): Response {
  return new Response(JSON.stringify(Body), { status: Status, headers: { 'Content-Type': 'application/json' } })
}

function configure() {
  vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.test/')
  vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-test')
  vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-test')
}

beforeEach(configure)
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Langfuse 观测读侧', () => {
  it('带 traceId 与字段组请求；input/output 解析成 JSON，费用与 token 原样穿过', async () => {
    const Fetch = vi.fn().mockResolvedValue(jsonResponse({ data: [Observation], meta: {} }))
    vi.stubGlobal('fetch', Fetch)
    const Result = await readLangfuseObservations('lf-trace-1')
    expect(Result.Observations).toHaveLength(1)
    expect(Result.Truncated).toBe(false)
    expect(Result.Observations[0]!.input).toEqual({ messages: [{ role: 'user', content: 'hi' }] })
    expect(Result.Observations[0]!.output).toEqual([{ type: 'text', text: 'hello' }])
    expect(Result.Observations[0]!.usageDetails).toEqual({ input: 10, output: 4, total: 14 })
    expect(Result.Observations[0]!.totalCost).toBe(0.001)
    expect(Result.Observations[0]!.toolCallId).toBe('call_1')
    const Url = new URL(Fetch.mock.calls[0]![0] as URL)
    expect(Url.pathname).toBe('/api/public/v2/observations')
    expect(Url.searchParams.get('traceId')).toBe('lf-trace-1')
    expect(Url.searchParams.get('fields')).toContain('io')
    expect((Fetch.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: expect.stringMatching(/^Basic /) })
  })

  it('按 meta.cursor 翻页；空 meta 就停', async () => {
    const Second = { ...Observation, id: 'obs-2', parentObservationId: 'obs-1', isRootObservation: false }
    const Fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [Observation], meta: { cursor: 'next-page' } }))
      .mockResolvedValueOnce(jsonResponse({ data: [Second], meta: {} }))
    vi.stubGlobal('fetch', Fetch)
    const Result = await readLangfuseObservations('lf-trace-1')
    expect(Result.Observations.map((Item) => Item.id)).toEqual(['obs-1', 'obs-2'])
    expect(Fetch).toHaveBeenCalledTimes(2)
    const SecondUrl = new URL(Fetch.mock.calls[1]![0] as URL)
    expect(SecondUrl.searchParams.get('cursor')).toBe('next-page')
  })

  it('空 data 是导出延迟，不抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [], meta: {} })))
    await expect(readLangfuseObservations('lf-trace-1')).resolves.toEqual({ Observations: [], Truncated: false })
  })

  it('坏形状、401、429 各自给稳定 code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{ bad: true }], meta: {} })))
    await expect(readLangfuseObservations('lf-trace-1')).rejects.toMatchObject({ code: 'E_LANGFUSE_SHAPE' })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'unauthorized' }, 401)))
    await expect(readLangfuseObservations('lf-trace-1')).rejects.toMatchObject({ code: 'E_LANGFUSE_AUTH', status: 502 })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'rate limited' }, 429)))
    await expect(readLangfuseObservations('lf-trace-1')).rejects.toMatchObject({ code: 'E_LANGFUSE_RATE_LIMIT', status: 503 })
  })

  it('三件套缺失时不发请求', async () => {
    vi.unstubAllEnvs()
    vi.stubEnv('LANGFUSE_BASE_URL', '')
    const Fetch = vi.fn()
    vi.stubGlobal('fetch', Fetch)
    expect(langfuseReady()).toBe(false)
    const Error = await readLangfuseObservations('lf-trace-1').catch((Thrown: unknown) => Thrown)
    expect(Error).toBeInstanceOf(LangfuseReadError)
    expect(Error).toMatchObject({ code: 'E_LANGFUSE_DISABLED' })
    expect(Fetch).not.toHaveBeenCalled()
  })
})
