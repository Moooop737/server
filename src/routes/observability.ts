/**
 * 对话观测路由 —— /chats 页面用：先只读本地库拿会话与 trace_id，打开某条对话时才去 Langfuse 读观测。
 *   GET /sessions            库里的会话 + 每个会话有几次 /chat（懒加载第一层）
 *   GET /chats?session_id=   最近的 /chat 行（带本地 trace_id / langfuse_trace_id），可按会话过滤
 *   GET /traces/:id          按本地 trace_id 读库拿 langfuse_trace_id，再读 Langfuse /api/public/v2/observations
 * 失败映射：分页/ID 非 UUID→400；trace 不存在→404；流未收口或没拿到 Langfuse trace id→409 E_LANGFUSE_PENDING；
 *   Langfuse 未配置→503；鉴权/限流/不可达/形状不符由 LangfuseReadError 自带状态码。
 * 不打印 Key；Langfuse 的读取失败不影响本地会话与对话列表。
 */

import 'reflect-metadata'
import { Hono } from 'hono'
import { inject, injectable } from 'tsyringe'
import { PostgresRepo } from '../adapter/contract'
import { LangfuseReadError, langfuseReady, readLangfuseObservations } from '../trace/llmtrace/read'
import { logError } from '../trace/systemtrace/log'

export { ObservabilityRoute }

import type { Context } from 'hono'
import type { ChatTraceSummary, Repo } from '../adapter/contract'

const PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100
const MAX_PAGE = 1_000_000

@injectable()
class ObservabilityRoute {
  private readonly repo: Repo

  constructor(@inject(PostgresRepo) Repo: Repo) {
    this.repo = Repo
  }

  build(): Hono {
    const app = new Hono()
    const repo = this.repo

    app.get('/sessions', async (c) => {
      const Paging = pagingOf(c.req.query('page'), c.req.query('per_page'))
      if (Paging === null) return badQuery(c)
      try {
        const Result = await repo.listChatSessions((Paging.Page - 1) * Paging.PerPage, Paging.PerPage)
        return c.json({
          sessions: Result.Items,
          langfuse_enabled: langfuseReady(),
          pagination: paginationOf(Paging.Page, Paging.PerPage, Result.TotalCount),
        })
      } catch (err) {
        logError('E_OBSERVABILITY_READ', String(err))
        return c.json({ code: 'E_OBSERVABILITY_READ', message: '读取会话观测失败' }, 500)
      }
    })

    app.get('/chats', async (c) => {
      const Paging = pagingOf(c.req.query('page'), c.req.query('per_page'))
      if (Paging === null) return badQuery(c)
      const RawSessionId = c.req.query('session_id')
      if (RawSessionId !== undefined && !uuidOk(RawSessionId)) {
        return c.json({ code: 'E_BAD_ID', message: 'session_id 需为 UUID' }, 400)
      }
      try {
        const Result = await repo.listChatTraces(
          RawSessionId ?? null,
          (Paging.Page - 1) * Paging.PerPage,
          Paging.PerPage,
        )
        return c.json({
          chats: Result.Items,
          pagination: paginationOf(Paging.Page, Paging.PerPage, Result.TotalCount),
        })
      } catch (err) {
        logError('E_OBSERVABILITY_READ', String(err))
        return c.json({ code: 'E_OBSERVABILITY_READ', message: '读取对话列表失败' }, 500)
      }
    })

    app.get('/traces/:id', async (c) => {
      const id = c.req.param('id').toLowerCase()
      if (!uuidOk(id)) {
        return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      }
      if (!langfuseReady()) {
        return c.json({ code: 'E_LANGFUSE_DISABLED', message: 'Langfuse 未配置，读不到观测内容' }, 503)
      }

      let Trace: ChatTraceSummary | null
      try {
        Trace = await repo.getChatTrace(id)
      } catch (err) {
        logError('E_OBSERVABILITY_READ', String(err))
        return c.json({ code: 'E_OBSERVABILITY_READ', message: '读取对话失败' }, 500)
      }
      if (Trace === null) {
        return c.json({ code: 'E_TRACE_NOT_FOUND', message: '这条对话不存在' }, 404)
      }
      if (Trace.langfuse_trace_id === null) {
        return c.json({ code: 'E_LANGFUSE_PENDING', message: '流还没收口，或 Langfuse 没有拿到 trace id' }, 409)
      }

      try {
        const Read = await readLangfuseObservations(Trace.langfuse_trace_id)
        return c.json({
          trace: Trace,
          observations: Read.Observations,
          truncated: Read.Truncated,
          fetched_at: new Date().toISOString(),
        })
      } catch (err) {
        if (err instanceof LangfuseReadError) {
          logError(err.code, err.message)
          return c.json({ code: err.code, message: err.message }, err.status)
        }
        logError('E_LANGFUSE_READ', String(err))
        return c.json({ code: 'E_LANGFUSE_READ', message: '读取 Langfuse 观测失败' }, 502)
      }
    })

    return app
  }
}

function paginationOf(Page: number, PerPage: number, TotalCount: number) {
  return {
    page: Page,
    per_page: PerPage,
    total_count: TotalCount,
    total_pages: Math.ceil(TotalCount / PerPage),
  }
}

function pagingOf(PageRaw: string | undefined, PerPageRaw: string | undefined): { Page: number; PerPage: number } | null {
  const Page = PageRaw === undefined ? 1 : Number(PageRaw)
  const PerPage = PerPageRaw === undefined ? PAGE_SIZE : Number(PerPageRaw)
  if (!Number.isInteger(Page) || Page < 1 || Page > MAX_PAGE) return null
  if (!Number.isInteger(PerPage) || PerPage < 1 || PerPage > MAX_PAGE_SIZE) return null
  return { Page, PerPage }
}

function badQuery(c: Context) {
  return c.json({ code: 'E_BAD_QUERY', message: `page 需为 1-${MAX_PAGE} 的整数，per_page 需为 1-${MAX_PAGE_SIZE} 的整数` }, 400)
}

function uuidOk(Id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(Id)
}
