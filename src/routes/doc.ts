/**
 * /doc —— Scalar API 参考页。文档 = 根 OpenAPIHono 生成的四表 CRUD + 本文件手写的自定义端点 JSON。
 * 生成的 CRUD 先按 crud.ts 的 envelope 元数据改写响应壳（list 的 key/pagination、item 的裸/包壳、delete 的 deleted），再合并自定义端点；
 * 自定义端点不写 createRoute，schema 直接以 JSON 对象维护在这里；同 path 的不同 method 相加，同名 method 视为冲突直接启动失败。
 * raw spec 在 /doc/openapi.json。
 */

import { Scalar } from '@scalar/hono-api-reference'
import { CrudDoc } from './crud'

export { createDocRoute }

import type { OpenAPIHono } from '@hono/zod-openapi'

const Info = {
  title: 'Knowledge Copilot API',
  version: '1.0.0',
  description: 'Knowledge Copilot 的接口文档；四张表的 CRUD 由 hono-crud 自动生成，自定义端点由手写 OpenAPI 补充。除 /health 与 /traces* 外的业务响应头带 X-Trace-Id，可用 GET /traces/{id} 回读。',
}

const Tags = [
  { name: 'Resources', description: '资源' },
  { name: 'Codebases', description: '代码库 ZIP：独立领域，不进资源/ingest/检索' },
  { name: 'Sessions', description: '会话' },
  { name: 'Messages', description: '消息' },
  { name: 'Traces', description: '端点观测 trace；payloads 只在失败/白名单成功时记录，列表不返回' },
  { name: 'Retrieve', description: '召回' },
  { name: 'Chat', description: '对话' },
  { name: 'Observability', description: '对话观测：列表读本地库，观测内容按 langfuse_trace_id 懒加载' },
  { name: 'Health', description: '服务探针' },
  { name: 'Config', description: '供应商 / 模型 / 默认模型配置；写接口保存后热更新' },
]

const Json = (Schema: object) => ({ 'application/json': { schema: Schema } })
const Ref = (Name: string) => ({ $ref: `#/components/schemas/${Name}` })
const Err = (Description: string) => ({ description: Description, content: Json(Ref('Error')) })
const Ok = (Description: string, Schema: object) => ({ description: Description, content: Json(Schema) })

const ReloadFields = {
  reload_ok: { type: 'boolean' },
  reload_error: { type: 'string' },
}

const WriteSchema = (Key: string, Schema: object) => ({
  type: 'object',
  required: [Key, 'reload_ok'],
  properties: { [Key]: Schema, ...ReloadFields },
})

const PageSchema = {
  type: 'object',
  required: ['page', 'per_page', 'total_count', 'total_pages'],
  properties: {
    page: { type: 'integer' },
    per_page: { type: 'integer' },
    total_count: { type: 'integer' },
    total_pages: { type: 'integer' },
  },
}

const ChatTraceSchema = {
  type: 'object',
  required: ['id', 'session_id', 'session_title', 'status', 'started_at', 'ended_at', 'duration_ms', 'error_code', 'langfuse_trace_id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    session_id: { type: 'string', format: 'uuid', nullable: true },
    session_title: { type: 'string', nullable: true },
    status: { type: 'string' },
    started_at: { type: 'string', format: 'date-time' },
    ended_at: { type: 'string', format: 'date-time', nullable: true },
    duration_ms: { type: 'integer', nullable: true },
    error_code: { type: 'string', nullable: true },
    langfuse_trace_id: { type: 'string', nullable: true },
  },
}

const CrudMethod = { list: 'get', read: 'get', create: 'post', update: 'patch', delete: 'delete' } as const

function Pascal(Name: string): string {
  return Name.split('_').map((Part) => Part.charAt(0).toUpperCase() + Part.slice(1)).join('')
}

function alignCrudOpenAPI(Document: any) {
  for (const Entry of CrudDoc) {
    for (const Endpoint of Entry.endpoints) {
      const Target = Endpoint === 'list' || Endpoint === 'create' ? Entry.path : `${Entry.path}/{id}`
      const Path = Document.paths[Target]
      if (!Path) throw new Error(`OpenAPI 缺少 CRUD path: ${Target}`)

      const Method = CrudMethod[Endpoint as keyof typeof CrudMethod]
      const Op = Path[Method]
      if (!Op) throw new Error(`OpenAPI 缺少 CRUD operation: ${Method.toUpperCase()} ${Target}`)

      Op.operationId = Endpoint === 'list' ? `list${Pascal(Entry.listKey)}` : `${Endpoint}${Pascal(Entry.itemKey)}`
      for (const Code of ['404', '409', '500']) {
        if (Op.responses[Code]) Op.responses[Code].content = Json(Ref('Error'))
      }

      if (Endpoint === 'delete') {
        if (Op.responses['200']) {
          Op.responses['200'].content = Json({
            type: 'object',
            required: ['deleted'],
            properties: { deleted: { type: 'boolean' } },
          })
        }
        continue
      }

      const Status = Endpoint === 'create' ? '201' : '200'
      const Res = Op.responses[Status]
      if (!Res) throw new Error(`OpenAPI 缺少 ${Status} 响应: ${Method.toUpperCase()} ${Target}`)
      const Source = Res.content?.['application/json']?.schema
      const Result = Source?.properties?.result
      if (!Result) throw new Error(`OpenAPI 响应缺少 result: ${Method.toUpperCase()} ${Target}`)

      if (Entry.path === '/traces' && Endpoint === 'list' && Result.items?.properties?.payloads) {
        delete Result.items.properties.payloads
        if (Array.isArray(Result.items.required)) {
          Result.items.required = Result.items.required.filter((Name: string) => Name !== 'payloads')
        }
      }

      Res.content['application/json'].schema = Endpoint === 'list'
        ? {
            type: 'object',
            required: [Entry.listKey, 'pagination'],
            properties: {
              [Entry.listKey]: Result,
              pagination: Source.properties.result_info,
            },
          }
        : Entry.rawItem
          ? Result
          : { type: 'object', required: [Entry.itemKey], properties: { [Entry.itemKey]: Result } }
    }
  }
}

const CustomPaths = {
  '/resources': {
    post: {
      tags: ['Resources'],
      operationId: 'createResource',
      summary: '归档 URL/粘贴文本，或返回文件 presign PUT 目标',
      requestBody: { required: true, content: Json(Ref('CreateResourceRequest')) },
      responses: {
        200: Ok('同内容命中：duplicate=库里有，restored=软删恢复；都不带 upload', {
          type: 'object',
          required: ['resource'],
          properties: {
            resource: Ref('Resource'),
            duplicate: { type: 'boolean' },
            restored: { type: 'boolean' },
          },
        }),
        201: Ok('文件返回上传目标；URL/粘贴返回 uploaded 资源', { oneOf: [Ref('ResourceCreated'), Ref('FileUploadCreated')] }),
        400: Err('url/content/filename、content_type、size 或路径不合法'),
        409: Ok('同 URL 已有未删除资源', Ref('ResourceFailed')),
        413: Err('文件声明大小超过上限'),
        422: Ok('建行后归档失败，resource 留痕为 upload_failed', Ref('ResourceFailed')),
        500: Err('归档失败'),
      },
    },
  },
  '/resources/deleted': {
    get: {
      tags: ['Resources'],
      operationId: 'listDeletedResources',
      summary: '「已删除」筛选：分页读取软删资源',
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000000 } },
        { name: 'per_page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
        { name: 'search', in: 'query', description: '按标题 / 来源搜索（最长 200 字）', schema: { type: 'string', maxLength: 200 } },
        { name: 'sort', in: 'query', schema: { type: 'string', enum: ['created_at', 'updated_at', 'deleted_at', 'title', 'status'] } },
        { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
      ],
      responses: {
        200: Ok('软删资源与分页元数据', {
          type: 'object',
          required: ['resources', 'pagination'],
          properties: {
            resources: { type: 'array', items: Ref('Resource') },
            pagination: PageSchema,
          },
        }),
        400: Err('分页参数不合法'),
        500: Err('读取回收站失败'),
      },
    },
  },
  '/resources/{id}': {
    delete: {
      tags: ['Resources'],
      operationId: 'deleteResource',
      summary: '软删资源',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '资源 UUID', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        204: { description: '已软删' },
        400: Err('id 不是 UUID'),
        404: Err('资源不存在或已删除'),
        500: Err('删除失败'),
      },
    },
  },
  '/resources/{id}/abort': {
    post: {
      tags: ['Resources'],
      operationId: 'abortResourceIngest',
      summary: '取消处理中的入库',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '资源 UUID', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        202: Ok('取消已按下，异步生效', Ref('AbortAccepted')),
        400: Err('id 不是 UUID'),
        404: Err('资源不存在或已删除'),
        409: Ok('资源不是 processing，或不在本进程的入库登记里', Ref('AbortConflict')),
        500: Err('取消失败'),
      },
    },
  },
  '/resources/{id}/confirm-upload': {
    post: {
      tags: ['Resources'],
      operationId: 'confirmResourceUpload',
      summary: '文件 PUT 后 stat/类型/大小门禁，转 uploaded（不解析正文）',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '资源 UUID', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: Ok('已确认上传，status=uploaded', Ref('ResourceCreated')),
        400: Err('id 不是 UUID'),
        404: Err('资源不存在或已删除'),
        409: Ok('资源正在处理/已就绪，或原始对象状态冲突', Ref('ResourceFailed')),
        422: Ok('对象缺失/为空/过大/类型不符，resource 留痕 upload_failed', Ref('ResourceFailed')),
        500: Err('确认上传失败'),
      },
    },
  },
  '/resources/{id}/ingest': {
    post: {
      tags: ['Resources'],
      operationId: 'ingestResource',
      summary: '对已归档资源做解析、切块、embedding；ready 可重跑并替换旧分块',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '资源 UUID', schema: { type: 'string', format: 'uuid' } },
      ],
      requestBody: { required: false, content: Json(Ref('IngestRequest')) },
      responses: {
        201: Ok('入库成功', Ref('IngestSuccess')),
        400: Err('id 不是 UUID、body 或 chunker 不合法'),
        404: Err('资源不存在或已删除'),
        409: Ok('资源正在处理，或原始对象状态冲突', Ref('ResourceFailed')),
        422: Ok('上传门禁失败或处理失败，resource 留痕', Ref('ResourceFailed')),
        500: Err('入库失败'),
      },
    },
  },
  '/resources/{id}/restore': {
    post: {
      tags: ['Resources'],
      operationId: 'restoreResource',
      summary: '恢复软删资源到 uploaded',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '资源 UUID', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: Ok('已恢复到 uploaded，等待再次 ingest', Ref('ResourceCreated')),
        400: Err('id 不是 UUID'),
        404: Err('资源不存在'),
        409: Ok('资源未删除，或原始文件不存在', Ref('ResourceFailed')),
        500: Err('恢复失败'),
      },
    },
  },
  '/resources/{id}/purge': {
    delete: {
      tags: ['Resources'],
      operationId: 'purgeResource',
      summary: '彻底删除回收站资源（先删原始对象，再删行并释放 content_hash）',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '资源 UUID', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        204: { description: '已彻底删除' },
        400: Err('id 不是 UUID'),
        404: Err('资源不存在'),
        409: Err('资源未在回收站（仅允许删除软删行）'),
        500: Err('删除原始对象失败，资源行保留'),
      },
    },
  },
  '/resources/{id}/original': {
    get: {
      tags: ['Resources'],
      operationId: 'downloadResourceOriginal',
      summary: '302 到原始文件 presigned GET',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '资源 UUID', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        302: {
          description: '重定向到 MinIO presigned GET（attachment + no-store）',
          headers: {
            Location: { schema: { type: 'string', format: 'uri' } },
            'Cache-Control': { schema: { type: 'string' } },
          },
        },
        400: Err('id 不是 UUID'),
        404: Err('资源不存在、原始文件不存在或不是 kc:// URI'),
        500: Err('生成下载地址失败'),
      },
    },
  },
  '/resources/{id}/chunks': {
    get: {
      tags: ['Resources'],
      operationId: 'listResourceChunks',
      summary: '分页读取资源分块（按内容搜索）',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '资源 UUID', schema: { type: 'string', format: 'uuid' } },
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000000 } },
        { name: 'per_page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
        { name: 'search', in: 'query', description: '按内容字面量匹配（最长 200 字）', schema: { type: 'string', maxLength: 200 } },
      ],
      responses: {
        200: Ok('当前页分块与分页元数据', {
          type: 'object',
          required: ['chunks', 'pagination'],
          properties: {
            chunks: { type: 'array', items: Ref('Chunk') },
            pagination: PageSchema,
          },
        }),
        400: Err('id 不是 UUID（E_BAD_ID），或分页参数不合法（E_BAD_QUERY）'),
        404: Err('资源不存在或已删除'),
        500: Err('读取分块失败'),
      },
    },
  },
  '/codebases': {
    get: {
      tags: ['Codebases'],
      operationId: 'listCodebases',
      summary: '分页读取代码库（不含 manifest）',
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000000 } },
        { name: 'per_page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
        { name: 'search', in: 'query', description: '按标题 / 原始文件名搜索', schema: { type: 'string', maxLength: 200 } },
      ],
      responses: {
        200: Ok('代码库列表与分页', {
          type: 'object',
          required: ['codebases', 'pagination'],
          properties: {
            codebases: { type: 'array', items: Ref('Codebase') },
            pagination: PageSchema,
          },
        }),
        400: Err('分页参数不合法'),
        500: Err('读取代码库列表失败'),
      },
    },
    post: {
      tags: ['Codebases'],
      operationId: 'createCodebase',
      summary: '建 uploading 行并返回 ZIP presign PUT 目标',
      requestBody: {
        required: true,
        content: Json({
          type: 'object',
          required: ['filename'],
          properties: {
            filename: { type: 'string', description: '只支持 .zip；不能包含路径' },
            size: { type: 'integer', minimum: 0, maximum: 104857600 },
            title: { type: 'string' },
          },
        }),
      },
      responses: {
        201: Ok('代码库行与上传目标', Ref('CodebaseUploadCreated')),
        400: Err('filename/size/title 不合法'),
        413: Err('声明大小超过 100MB'),
        500: Err('创建上传目标失败'),
      },
    },
  },
  '/codebases/{id}': {
    get: {
      tags: ['Codebases'],
      operationId: 'readCodebase',
      summary: '读取代码库元数据（不含 manifest）',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '代码库 UUID', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: Ok('代码库元数据', { type: 'object', required: ['codebase'], properties: { codebase: Ref('Codebase') } }),
        400: Err('id 不是 UUID'),
        404: Err('代码库不存在'),
        500: Err('读取代码库失败'),
      },
    },
    delete: {
      tags: ['Codebases'],
      operationId: 'deleteCodebase',
      summary: '硬删代码库（先删 MinIO 原 ZIP，再删行）',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '代码库 UUID', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        204: { description: '已删除' },
        400: Err('id 不是 UUID'),
        404: Err('代码库不存在'),
        409: Err('代码库正在校验，不能删除'),
        500: Err('删除对象失败，行保留'),
      },
    },
  },
  '/codebases/{id}/complete': {
    post: {
      tags: ['Codebases'],
      operationId: 'completeCodebase',
      summary: '完成上传：stat、读 ZIP 中央目录、写 manifest 或转 failed',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '代码库 UUID', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: Ok('校验完成，status=ready', { type: 'object', required: ['codebase'], properties: { codebase: Ref('Codebase') } }),
        400: Err('id 不是 UUID'),
        404: Err('代码库不存在'),
        409: Err('代码库不是 uploading'),
        422: Ok('上传/ ZIP 校验失败，codebase 留痕 failed', {
          type: 'object',
          required: ['code', 'message'],
          properties: { code: { type: 'string' }, message: { type: 'string' }, codebase: Ref('Codebase') },
        }),
        500: Err('读取 ZIP 或生成上传目标失败'),
      },
    },
  },
  '/codebases/{id}/tree': {
    get: {
      tags: ['Codebases'],
      operationId: 'readCodebaseTree',
      summary: '读取扁平文件清单（树由前端合成）',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '代码库 UUID', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: Ok('扁平条目清单', {
          type: 'object',
          required: ['entries'],
          properties: { entries: { type: 'array', items: Ref('CodebaseEntry') } },
        }),
        400: Err('id 不是 UUID'),
        404: Err('代码库不存在'),
        409: Err('代码库还不是 ready'),
        500: Err('读取文件树失败'),
      },
    },
  },
  '/codebases/{id}/files/{entryIndex}': {
    get: {
      tags: ['Codebases'],
      operationId: 'readCodebaseFile',
      summary: '按 entryIndex 流式读取单个条目；默认 inline，?download=1 下载',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '代码库 UUID', schema: { type: 'string', format: 'uuid' } },
        { name: 'entryIndex', in: 'path', required: true, description: 'manifest 里的 entry_index', schema: { type: 'integer', minimum: 0 } },
        { name: 'download', in: 'query', description: '1 = attachment；否则 inline', schema: { type: 'string', enum: ['1'] } },
      ],
      responses: {
        200: {
          description: '文本/代码为 text/plain，二进制为 application/octet-stream；不执行 HTML/SVG',
          headers: {
            'Content-Disposition': { schema: { type: 'string' } },
            'X-Content-Type-Options': { schema: { type: 'string' } },
          },
          content: {
            'text/plain': { schema: { type: 'string' } },
            'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
          },
        },
        400: Err('id/entryIndex 不合法，或目标是目录'),
        404: Err('代码库或条目不存在'),
        409: Err('代码库还不是 ready'),
        413: Err('条目实际解压字节超过 100MB'),
        422: Err('ZIP 读取失败'),
        500: Err('读取文件失败'),
      },
    },
  },
  '/codebases/{id}/original': {
    get: {
      tags: ['Codebases'],
      operationId: 'downloadCodebaseOriginal',
      summary: '302 到原 ZIP 的 presigned GET',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '代码库 UUID', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        302: {
          description: '重定向到 MinIO presigned GET（attachment + no-store）',
          headers: {
            Location: { schema: { type: 'string', format: 'uri' } },
            'Cache-Control': { schema: { type: 'string' } },
          },
        },
        400: Err('id 不是 UUID'),
        404: Err('代码库或原始 ZIP 不存在'),
        409: Err('代码库还不是 ready'),
        500: Err('生成下载地址失败'),
      },
    },
  },
  '/sessions/{id}/messages': {
    get: {
      tags: ['Sessions'],
      operationId: 'listSessionMessages',
      summary: '读取会话消息',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '会话 UUID', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: Ok('按 sequence 正序返回的消息', {
          type: 'object',
          required: ['id', 'messages'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            messages: { type: 'array', items: Ref('Message') },
          },
        }),
        400: Err('id 不是 UUID'),
        404: Err('会话不存在或已删除'),
        500: Err('读取会话失败'),
      },
    },
  },
  '/observability/sessions': {
    get: {
      tags: ['Observability'],
      operationId: 'listChatSessions',
      summary: '有对话的会话（本地库）',
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
        { name: 'per_page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
      ],
      responses: {
        200: Ok('会话摘要、分页与 Langfuse 是否可用', {
          type: 'object',
          required: ['sessions', 'langfuse_enabled', 'pagination'],
          properties: {
            sessions: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'title', 'updated_at', 'chat_count', 'last_chat_at'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  title: { type: 'string' },
                  group_name: { type: 'string', nullable: true },
                  updated_at: { type: 'string', format: 'date-time' },
                  chat_count: { type: 'integer' },
                  last_chat_at: { type: 'string', format: 'date-time' },
                },
              },
            },
            langfuse_enabled: { type: 'boolean' },
            pagination: PageSchema,
          },
        }),
        400: Err('分页参数不合法'),
        500: Err('读取会话观测失败'),
      },
    },
  },
  '/observability/sessions/{id}/transcript': {
    get: {
      tags: ['Observability'],
      operationId: 'readSessionTranscript',
      summary: '会话按轮摊平：每条 /chat trace + 归到它名下的消息（本地库）',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '会话 UUID', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: Ok('轮与消息；观测内容仍按 trace id 懒加载', {
          type: 'object',
          required: ['turns'],
          properties: {
            turns: {
              type: 'array',
              items: {
                type: 'object',
                required: ['trace', 'messages'],
                properties: {
                  trace: ChatTraceSchema,
                  messages: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'role', 'content', 'created_at'],
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        role: { type: 'string', enum: ['user', 'assistant'] },
                        content: { type: 'string' },
                        created_at: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        400: Err('id 不是 UUID'),
        404: Err('会话不存在或已删除'),
        500: Err('读取会话消息失败'),
      },
    },
  },
  '/observability/traces/{id}': {
    get: {
      tags: ['Observability'],
      operationId: 'readChatObservations',
      summary: '按本地 trace id 懒加载 Langfuse 观测',
      parameters: [
        { name: 'id', in: 'path', required: true, description: '本地 trace UUID', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: Ok('Langfuse observations（input/output 已尽量解析为 JSON）', {
          type: 'object',
          required: ['trace', 'observations', 'truncated', 'fetched_at'],
          properties: {
            trace: ChatTraceSchema,
            observations: { type: 'array', items: { type: 'object', additionalProperties: true } },
            truncated: { type: 'boolean' },
            fetched_at: { type: 'string', format: 'date-time' },
          },
        }),
        400: Err('id 不是 UUID'),
        404: Err('这条对话不存在'),
        409: Err('流未收口，或没有拿到 Langfuse trace id'),
        502: Err('Langfuse 鉴权/读取失败'),
        503: Err('Langfuse 未配置、限流或不可达'),
      },
    },
  },
  '/traces/{id}': {
    get: {
      tags: ['Traces'],
      operationId: 'getTraceWithStages',
      summary: '读取单条 endpoint trace 与阶段',
      parameters: [
        { name: 'id', in: 'path', required: true, description: 'trace id', schema: { type: 'string' } },
      ],
      responses: {
        200: Ok('trace + stages', {
          type: 'object',
          required: ['trace', 'stages'],
          properties: {
            trace: Ref('Trace'),
            stages: { type: 'array', items: Ref('TraceStage') },
          },
        }),
        404: Err('trace 不存在'),
        500: Err('读取观测失败'),
      },
    },
  },
  '/retrieve': {
    post: {
      tags: ['Retrieve'],
      operationId: 'retrieve',
      summary: '混合检索',
      requestBody: { required: true, content: Json(Ref('RetrieveRequest')) },
      responses: {
        200: Ok('融合结果；0 命中也是 200', Ref('RetrieveResponse')),
        400: Err('body.query 不合法或为空白'),
        409: Err('库中存在与当前检索维度不符的向量'),
        500: Err('检索失败'),
      },
    },
  },
  '/chat': {
    post: {
      tags: ['Chat'],
      operationId: 'chat',
      summary: '流式问答（AI SDK UI Message Stream）',
      requestBody: {
        required: true,
        content: Json({
          type: 'object',
          required: ['query', 'sessionId'],
          properties: {
            query: { type: 'string' },
            sessionId: { type: 'string', format: 'uuid', description: 'POST /sessions 生成的会话 UUID' },
          },
        }),
      },
      responses: {
        200: {
          description: 'SSE 流；Scalar 的 Try it 可能只显示原始流，建议用前端/curl',
          content: { 'text/event-stream': { schema: { type: 'string' } } },
        },
        400: Err('body.query 不合法或为空白；sessionId 不是 UUID'),
        404: Err('会话不存在或已删除'),
        500: Err('问答失败'),
      },
    },
  },
  '/config/status': {
    get: {
      tags: ['Config'],
      operationId: 'getConfigStatus',
      summary: '当前运行时快照状态',
      responses: {
        200: Ok('生成号、计数、默认可用性、最近一次 reload', Ref('ConfigStatus')),
        503: Err('运行时配置尚未装载'),
      },
    },
  },
  '/config/reload': {
    post: {
      tags: ['Config'],
      operationId: 'reloadConfig',
      summary: '手动重载运行时配置',
      responses: {
        200: Ok('重载结果', { type: 'object', required: ['reload_ok'], properties: ReloadFields }),
      },
    },
  },
  '/config/providers': {
    get: {
      tags: ['Config'],
      operationId: 'listConfigProviders',
      summary: '供应商列表（脱敏）',
      responses: {
        200: Ok('供应商列表', {
          type: 'object',
          required: ['providers'],
          properties: { providers: { type: 'array', items: Ref('ConfigProvider') } },
        }),
        500: Err('读取失败'),
      },
    },
    post: {
      tags: ['Config'],
      operationId: 'createConfigProvider',
      summary: '新建供应商',
      requestBody: { required: true, content: Json(Ref('ConfigProviderCreate')) },
      responses: {
        200: Ok('新建结果；写后已尝试热更新', WriteSchema('provider', Ref('ConfigProvider'))),
        400: Err('name / kind / base_url / options 不合法'),
        409: Err('供应商名称已存在'),
        500: Err('新建失败'),
      },
    },
  },
  '/config/providers/{id}': {
    patch: {
      tags: ['Config'],
      operationId: 'updateConfigProvider',
      summary: '改 base_url / enabled / options',
      requestBody: { required: true, content: Json(Ref('ConfigProviderPatch')) },
      responses: {
        200: Ok('更新结果；写后已尝试热更新', WriteSchema('provider', Ref('ConfigProvider'))),
        400: Err('base_url / enabled / options 不合法'),
        404: Err('供应商不存在'),
      },
    },
    delete: {
      tags: ['Config'],
      operationId: 'deleteConfigProvider',
      summary: '硬删供应商，级联模型与默认行',
      responses: {
        200: Ok('删除结果；写后已尝试热更新', WriteSchema('deleted', { type: 'boolean' })),
        404: Err('供应商不存在'),
      },
    },
  },
  '/config/providers/{id}/api-key': {
    put: {
      tags: ['Config'],
      operationId: 'setConfigProviderApiKey',
      summary: '设置 / 替换供应商 Key（AES-GCM 入库）',
      requestBody: { required: true, content: Json(Ref('ConfigApiKey')) },
      responses: {
        200: Ok('更新结果；响应不回明文 Key', WriteSchema('provider', Ref('ConfigProvider'))),
        400: Err('api_key 不合法'),
        404: Err('供应商不存在'),
        500: Err('加密或保存失败'),
      },
    },
    delete: {
      tags: ['Config'],
      operationId: 'clearConfigProviderApiKey',
      summary: '清除供应商 Key',
      responses: {
        200: Ok('更新结果', WriteSchema('provider', Ref('ConfigProvider'))),
        404: Err('供应商不存在'),
      },
    },
  },
  '/config/providers/{id}/headers': {
    put: {
      tags: ['Config'],
      operationId: 'setConfigProviderHeaders',
      summary: '整组替换自定义 headers（加密）',
      requestBody: { required: true, content: Json(Ref('ConfigHeaders')) },
      responses: {
        200: Ok('更新结果；只回字段名', WriteSchema('provider', Ref('ConfigProvider'))),
        400: Err('headers 名称 / 值 / 大小不合法'),
        404: Err('供应商不存在'),
        500: Err('加密或保存失败'),
      },
    },
  },
  '/config/providers/{id}/query': {
    put: {
      tags: ['Config'],
      operationId: 'setConfigProviderQuery',
      summary: '整组替换自定义 query（明文）',
      requestBody: { required: true, content: Json(Ref('ConfigQuery')) },
      responses: {
        200: Ok('更新结果', WriteSchema('provider', Ref('ConfigProvider'))),
        400: Err('query 键值 / 大小不合法'),
        404: Err('供应商不存在'),
      },
    },
  },
  '/config/providers/test': {
    post: {
      tags: ['Config'],
      operationId: 'testConfigProviderDraft',
      summary: '连接测试（草稿，不落库）',
      requestBody: { required: true, content: Json(Ref('ConfigDraftProbe')) },
      responses: {
        200: Ok('测试结果', Ref('ConfigProbeResult')),
        400: Err('kind / base_url / api_key / headers / query 不合法'),
      },
    },
  },
  '/config/providers/{id}/test': {
    post: {
      tags: ['Config'],
      operationId: 'testConfigProvider',
      summary: '连接测试（已存供应商）',
      responses: {
        200: Ok('测试结果', Ref('ConfigProbeResult')),
        404: Err('供应商不存在'),
        500: Err('Key / headers 解密失败'),
      },
    },
  },
  '/config/providers/{id}/discover': {
    post: {
      tags: ['Config'],
      operationId: 'discoverConfigProviderModels',
      summary: '拉上游模型清单（只读）',
      responses: {
        200: Ok('上游清单与 already_added 标记', Ref('ConfigDiscoverResult')),
        404: Err('供应商不存在'),
        500: Err('Key / headers 解密失败'),
        502: Err('上游不可达 / 鉴权失败 / 清单形状不合法'),
      },
    },
  },
  '/config/providers/{id}/models/import': {
    post: {
      tags: ['Config'],
      operationId: 'importConfigProviderModels',
      summary: '导入用户勾选的模型',
      requestBody: { required: true, content: Json(Ref('ConfigImportRequest')) },
      responses: {
        200: Ok('导入结果；写后已尝试热更新', Ref('ConfigImportResult')),
        400: Err('model_id / kind / display_name / dimensions 不合法'),
        404: Err('供应商不存在'),
        500: Err('导入失败'),
      },
    },
  },
  '/config/models': {
    get: {
      tags: ['Config'],
      operationId: 'listConfigModels',
      summary: '全部真实模型行（不含默认行）',
      responses: {
        200: Ok('模型列表', {
          type: 'object',
          required: ['models'],
          properties: { models: { type: 'array', items: Ref('ConfigModel') } },
        }),
        503: Err('运行时配置尚未装载'),
      },
    },
    post: {
      tags: ['Config'],
      operationId: 'createConfigModel',
      summary: '新建模型行',
      requestBody: { required: true, content: Json(Ref('ConfigModelCreate')) },
      responses: {
        200: Ok('新建结果；写后已尝试热更新', WriteSchema('model', Ref('ConfigModel'))),
        400: Err('provider / model / kind / dimensions 不合法'),
        409: Err('模型已存在'),
      },
    },
  },
  '/config/models/{id}': {
    patch: {
      tags: ['Config'],
      operationId: 'updateConfigModel',
      summary: '改 display_name / dimensions / enabled',
      requestBody: { required: true, content: Json(Ref('ConfigModelPatch')) },
      responses: {
        200: Ok('更新结果；写后已尝试热更新', WriteSchema('model', Ref('ConfigModel'))),
        400: Err('display_name / dimensions / enabled 不合法'),
        404: Err('模型不存在'),
      },
    },
    delete: {
      tags: ['Config'],
      operationId: 'deleteConfigModel',
      summary: '硬删模型，同事务删指向它的默认行',
      responses: {
        200: Ok('删除结果；写后已尝试热更新', WriteSchema('deleted', { type: 'boolean' })),
        404: Err('模型不存在'),
      },
    },
  },
  '/config/defaults': {
    get: {
      tags: ['Config'],
      operationId: 'listConfigDefaults',
      summary: '默认对话 / 嵌入模型',
      responses: {
        200: Ok('默认行列表', {
          type: 'object',
          required: ['defaults'],
          properties: { defaults: { type: 'array', items: Ref('ConfigDefault') } },
        }),
      },
    },
  },
  '/config/defaults/{id}': {
    put: {
      tags: ['Config'],
      operationId: 'setConfigDefault',
      summary: '设置默认模型；id=default 或 embedding',
      requestBody: { required: true, content: Json(Ref('ConfigDefaultPut')) },
      responses: {
        200: Ok('设置结果；写后已尝试热更新', WriteSchema('default', { type: ['object', 'null'], oneOf: [Ref('ConfigModel'), { type: 'null' }] })),
        400: Err('provider / model_id / kind 不匹配'),
      },
    },
    delete: {
      tags: ['Config'],
      operationId: 'deleteConfigDefault',
      summary: '删除默认行',
      responses: {
        200: Ok('删除结果；写后已尝试热更新', WriteSchema('deleted', { type: 'boolean' })),
        404: Err('默认行不存在'),
      },
    },
  },
  '/health': {
    get: {
      tags: ['Health'],
      operationId: 'getHealth',
      summary: '服务探针聚合',
      responses: {
        200: Ok('全部探针通过', Ref('HealthResponse')),
        503: Ok('至少一个探针失败（degraded）', Ref('HealthResponse')),
      },
    },
  },
}

const CustomSchemas = {
  ConfigProvider: {
    type: 'object',
    required: ['id', 'name', 'kind', 'icon', 'base_url', 'has_api_key', 'key_status', 'has_headers', 'header_names', 'headers_status', 'query', 'options', 'enabled', 'available', 'unavailable_reason', 'model_count', 'created_at', 'updated_at'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      kind: { type: 'string', enum: ['deepseek', 'dashscope', 'openai-compatible', 'ollama'] },
      icon: { type: ['string', 'null'], maxLength: 32 },
      base_url: { type: ['string', 'null'] },
      has_api_key: { type: 'boolean' },
      key_status: { type: 'string', enum: ['none', 'set', 'error'] },
      has_headers: { type: 'boolean' },
      header_names: { type: 'array', items: { type: 'string' } },
      headers_status: { type: 'string', enum: ['none', 'set', 'error'] },
      query: { type: 'object', additionalProperties: { type: 'string' } },
      options: { type: 'object', additionalProperties: true },
      enabled: { type: 'boolean' },
      available: { type: 'boolean' },
      unavailable_reason: { type: ['string', 'null'] },
      model_count: { type: 'integer' },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },
  ConfigModel: {
    type: 'object',
    required: ['id', 'provider_id', 'provider_name', 'provider_kind', 'model_id', 'kind', 'display_name', 'dimensions', 'enabled', 'available', 'unavailable_reason'],
    properties: {
      id: { type: 'string' },
      provider_id: { type: 'string', format: 'uuid' },
      provider_name: { type: 'string' },
      provider_kind: { type: 'string' },
      model_id: { type: 'string' },
      kind: { type: 'string', enum: ['language', 'embedding'] },
      display_name: { type: 'string' },
      dimensions: { type: ['integer', 'null'] },
      enabled: { type: 'boolean' },
      available: { type: 'boolean' },
      unavailable_reason: { type: ['string', 'null'] },
    },
  },
  ConfigDefault: {
    type: 'object',
    required: ['id', 'provider', 'model_id', 'key', 'kind', 'dimensions', 'available', 'unavailable_reason', 'updated_at'],
    properties: {
      id: { type: 'string', enum: ['default', 'embedding'] },
      provider: { type: 'string' },
      model_id: { type: 'string' },
      key: { type: 'string' },
      kind: { type: 'string', enum: ['language', 'embedding'] },
      dimensions: { type: ['integer', 'null'] },
      available: { type: 'boolean' },
      unavailable_reason: { type: ['string', 'null'] },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },
  ConfigStatus: {
    type: 'object',
    required: ['loaded_at', 'provider_count', 'model_count', 'default_chat_available', 'default_embedding_available', 'last_reload'],
    properties: {
      loaded_at: { type: 'string', format: 'date-time' },
      provider_count: { type: 'integer' },
      model_count: { type: 'integer' },
      default_chat_available: { type: 'boolean' },
      default_embedding_available: { type: 'boolean' },
      last_reload: {
        type: ['object', 'null'],
        properties: {
          ok: { type: 'boolean' },
          at: { type: 'string', format: 'date-time' },
          error_code: { type: ['string', 'null'] },
        },
      },
    },
  },
  ConfigProviderCreate: {
    type: 'object',
    required: ['name', 'kind'],
    properties: {
      name: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,31}$' },
      kind: { type: 'string', enum: ['deepseek', 'dashscope', 'openai-compatible', 'ollama'] },
      icon: { type: ['string', 'null'], maxLength: 32 },
      base_url: { type: ['string', 'null'] },
      options: { type: 'object', additionalProperties: true },
    },
  },
  ConfigProviderPatch: {
    type: 'object',
    properties: {
      base_url: { type: ['string', 'null'] },
      enabled: { type: 'boolean' },
      options: { type: 'object', additionalProperties: true },
      icon: { type: ['string', 'null'], maxLength: 32 },
    },
  },
  ConfigApiKey: {
    type: 'object',
    required: ['api_key'],
    properties: { api_key: { type: 'string', minLength: 1, maxLength: 4096 } },
  },
  ConfigHeaders: {
    type: 'object',
    required: ['headers'],
    properties: { headers: { type: 'object', additionalProperties: { type: 'string' } } },
  },
  ConfigQuery: {
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'object', additionalProperties: { type: 'string' } } },
  },
  ConfigDraftProbe: {
    type: 'object',
    required: ['kind'],
    properties: {
      kind: { type: 'string', enum: ['deepseek', 'dashscope', 'openai-compatible', 'ollama'] },
      base_url: { type: ['string', 'null'] },
      api_key: { type: 'string' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      query: { type: 'object', additionalProperties: { type: 'string' } },
    },
  },
  ConfigProbeResult: {
    type: 'object',
    required: ['ok', 'latency_ms'],
    properties: {
      ok: { type: 'boolean' },
      status: { type: 'integer' },
      latency_ms: { type: 'integer' },
      model_count: { type: 'integer' },
      message: { type: 'string' },
    },
  },
  ConfigDiscoveredModel: {
    type: 'object',
    required: ['model_id', 'owned_by', 'created', 'already_added', 'already_kind'],
    properties: {
      model_id: { type: 'string' },
      owned_by: { type: ['string', 'null'] },
      created: { type: ['integer', 'null'] },
      already_added: { type: 'boolean' },
      already_kind: { type: ['string', 'null'], enum: ['language', 'embedding', null] },
    },
  },
  ConfigDiscoverResult: {
    type: 'object',
    required: ['fetched_at', 'source', 'models'],
    properties: {
      fetched_at: { type: 'string', format: 'date-time' },
      source: { type: 'string', enum: ['openai-models', 'ollama-tags'] },
      models: { type: 'array', items: Ref('ConfigDiscoveredModel') },
    },
  },
  ConfigModelCreate: {
    type: 'object',
    required: ['provider_id', 'model_id', 'kind', 'display_name'],
    properties: {
      provider_id: { type: 'string', format: 'uuid' },
      model_id: { type: 'string' },
      kind: { type: 'string', enum: ['language', 'embedding'] },
      display_name: { type: 'string', maxLength: 80 },
      dimensions: { type: ['integer', 'null'], minimum: 1, maximum: 16000 },
    },
  },
  ConfigModelPatch: {
    type: 'object',
    properties: {
      display_name: { type: 'string', maxLength: 80 },
      enabled: { type: 'boolean' },
      dimensions: { type: ['integer', 'null'], minimum: 1, maximum: 16000 },
    },
  },
  ConfigDefaultPut: {
    type: 'object',
    required: ['provider', 'model_id'],
    properties: { provider: { type: 'string' }, model_id: { type: 'string' } },
  },
  ConfigImportRequest: {
    type: 'object',
    required: ['models'],
    properties: {
      models: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['model_id', 'kind'],
          properties: {
            model_id: { type: 'string' },
            kind: { type: 'string', enum: ['language', 'embedding'] },
            display_name: { type: 'string' },
            dimensions: { type: 'integer', minimum: 1, maximum: 16000 },
          },
        },
      },
    },
  },
  ConfigImportResult: {
    type: 'object',
    required: ['added', 'skipped', 'reload_ok'],
    properties: {
      added: { type: 'array', items: { type: 'object', additionalProperties: true } },
      skipped: { type: 'array', items: { type: 'object', additionalProperties: true } },
      reload_ok: { type: 'boolean' },
      reload_error: { type: 'string' },
    },
  },
  ConfigWriteMeta: {
    type: 'object',
    required: ['reload_ok'],
    properties: {
      reload_ok: { type: 'boolean' },
      reload_error: { type: 'string' },
    },
  },
  Trace: {
    type: 'object',
    required: ['id', 'route', 'started_at', 'status', 'created_at'],
    properties: {
      id: { type: 'string' },
      session_id: { type: ['string', 'null'], format: 'uuid' },
      resource_id: { type: ['string', 'null'], format: 'uuid' },
      route: { type: 'string' },
      http_status: { type: ['integer', 'null'] },
      started_at: { type: 'string', format: 'date-time' },
      ended_at: { type: ['string', 'null'], format: 'date-time' },
      duration_ms: { type: ['integer', 'null'] },
      status: { type: 'string', enum: ['running', 'ok', 'error', 'cancelled'] },
      error_code: { type: ['string', 'null'] },
      langfuse_trace_id: { type: ['string', 'null'] },
      payloads: { type: ['object', 'null'], additionalProperties: true },
      created_at: { type: 'string', format: 'date-time' },
    },
  },
  TraceStage: {
    type: 'object',
    required: ['id', 'trace_id', 'stage', 'input', 'output', 'duration_ms', 'status', 'created_at'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      trace_id: { type: 'string' },
      stage: { type: 'string' },
      input: { type: 'object', additionalProperties: true },
      output: { type: 'object', additionalProperties: true },
      duration_ms: { type: 'integer' },
      status: { type: 'string', enum: ['ok', 'error'] },
      created_at: { type: 'string', format: 'date-time' },
    },
  },
  Error: {
    type: 'object',
    required: ['code', 'message'],
    properties: { code: { type: 'string' }, message: { type: 'string' } },
  },
  Resource: {
    type: 'object',
    required: ['id', 'title', 'source', 'data_uri', 'content_type', 'status', 'error_reason', 'storage_size_bytes', 'content_hash', 'created_at', 'updated_at', 'deleted_at'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      title: { type: 'string' },
      source: { type: ['string', 'null'] },
      data_uri: { type: 'string' },
      content_type: { type: 'string', description: '文件 MIME，例如 text/html / text/markdown / text/plain' },
      status: { type: 'string', enum: ['uploading', 'uploaded', 'processing', 'ready', 'upload_failed', 'process_failed'] },
      error_reason: { type: ['string', 'null'] },
      storage_size_bytes: { type: ['integer', 'null'], format: 'int64' },
      content_hash: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$', description: '归档原始字节的 SHA-256；URL 抓取失败等未算 hash 的行为 null' },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      deleted_at: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  CodebaseEntry: {
    type: 'object',
    required: ['path', 'entry_index', 'is_dir', 'compressed_size', 'uncompressed_size', 'compression_method'],
    properties: {
      path: { type: 'string' },
      entry_index: { type: 'integer', minimum: 0 },
      is_dir: { type: 'boolean' },
      compressed_size: { type: 'integer', minimum: 0 },
      uncompressed_size: { type: 'integer', minimum: 0 },
      compression_method: { type: 'integer' },
    },
  },
  Codebase: {
    type: 'object',
    required: ['id', 'title', 'original_filename', 'data_uri', 'content_type', 'status', 'error_reason', 'storage_size_bytes', 'file_count', 'declared_uncompressed_bytes', 'created_at', 'updated_at'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      title: { type: 'string' },
      original_filename: { type: 'string' },
      data_uri: { type: 'string' },
      content_type: { type: 'string', enum: ['application/zip'] },
      status: { type: 'string', enum: ['uploading', 'processing', 'ready', 'failed'] },
      error_reason: { type: ['string', 'null'] },
      storage_size_bytes: { type: ['integer', 'null'], format: 'int64' },
      file_count: { type: 'integer', minimum: 0 },
      declared_uncompressed_bytes: { type: 'integer', minimum: 0 },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },
  CodebaseUploadCreated: {
    type: 'object',
    required: ['codebase', 'upload'],
    properties: {
      codebase: Ref('Codebase'),
      upload: {
        type: 'object',
        required: ['url', 'method', 'contentType'],
        properties: {
          url: { type: 'string', format: 'uri' },
          method: { type: 'string', enum: ['PUT'] },
          contentType: { type: 'string', enum: ['application/zip'] },
        },
      },
    },
  },
  Chunk: {
    type: 'object',
    required: ['id', 'resource_id', 'resource_uri', 'chunk_index', 'content', 'start_offset', 'end_offset', 'created_at', 'updated_at', 'deleted_at'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      resource_id: { type: 'string', format: 'uuid' },
      resource_uri: { type: 'string' },
      chunk_index: { type: 'integer' },
      content: { type: 'string' },
      start_offset: { type: ['integer', 'null'] },
      end_offset: { type: ['integer', 'null'] },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      deleted_at: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  Message: {
    type: 'object',
    required: ['id', 'session_id', 'role', 'content', 'parts', 'sequence', 'created_at', 'updated_at', 'deleted_at'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      session_id: { type: 'string', format: 'uuid' },
      role: { type: 'string', enum: ['user', 'assistant'] },
      content: { type: 'string' },
      parts: { type: 'array', description: 'AI SDK UIMessage.parts；第一版先用宽松对象', items: { type: 'object', additionalProperties: true } },
      sequence: { type: 'integer', format: 'int64' },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      deleted_at: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  CreateResourceRequest: {
    type: 'object',
    description: 'url、content、filename 必须恰好给一个；给 content 时 content_type 必填',
    properties: {
      url: { type: 'string', format: 'uri' },
      content: { type: 'string' },
      filename: { type: 'string', description: '只支持 .md/.txt；文件由浏览器直传 MinIO' },
      size: { type: 'integer', minimum: 0, maximum: 10485760 },
      content_hash: { type: 'string', pattern: '^[0-9a-f]{64}$', description: '文件必填：原始字节的 SHA-256 小写 hex；URL/粘贴由服务端算' },
      content_type: { type: 'string', enum: ['text/markdown', 'text/plain'] },
      title: { type: 'string' },
    },
  },
  ResourceCreated: {
    type: 'object',
    required: ['resource'],
    properties: { resource: Ref('Resource') },
  },
  FileUploadCreated: {
    type: 'object',
    required: ['resource', 'upload'],
    properties: {
      resource: Ref('Resource'),
      upload: {
        type: 'object',
        required: ['url', 'method', 'contentType'],
        properties: {
          url: { type: 'string', format: 'uri' },
          method: { type: 'string', enum: ['PUT'] },
          contentType: { type: 'string' },
        },
      },
    },
  },
  IngestRequest: {
    type: 'object',
    properties: {
      chunker: { type: 'string', default: 'legacy' },
    },
  },
  IngestSuccess: {
    type: 'object',
    required: ['resource', 'chunk_count'],
    properties: {
      resource: Ref('Resource'),
      chunk_count: { type: 'integer' },
      warning: { type: 'string' },
    },
  },
  ResourceFailed: {
    type: 'object',
    required: ['code', 'message', 'resource'],
    properties: {
      code: { type: 'string' },
      message: { type: 'string' },
      resource: Ref('Resource'),
    },
  },
  AbortAccepted: {
    type: 'object',
    required: ['message', 'resource_id'],
    properties: { message: { type: 'string' }, resource_id: { type: 'string', format: 'uuid' } },
  },
  AbortConflict: {
    type: 'object',
    required: ['code', 'message', 'resource_id'],
    properties: {
      code: { type: 'string' },
      message: { type: 'string' },
      resource_id: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['uploading', 'uploaded', 'processing', 'ready', 'upload_failed', 'process_failed', 'gone'] },
    },
  },
  RetrieveRequest: {
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1 } },
  },
  RetrieveHit: {
    type: 'object',
    required: ['chunkId', 'resourceId', 'chunkIndex', 'startOffset', 'endOffset', 'docTitle', 'source', 'dataUri', 'score', 'similarity', 'lexicalScore', 'content'],
    properties: {
      chunkId: { type: 'string', format: 'uuid' },
      resourceId: { type: 'string', format: 'uuid' },
      chunkIndex: { type: 'integer' },
      startOffset: { type: ['integer', 'null'] },
      endOffset: { type: ['integer', 'null'] },
      docTitle: { type: 'string' },
      source: { type: ['string', 'null'] },
      dataUri: { type: 'string' },
      score: { type: 'number' },
      similarity: { type: ['number', 'null'] },
      lexicalScore: { type: ['number', 'null'] },
      content: { type: 'string' },
    },
  },
  RetrieveResponse: {
    type: 'object',
    required: ['hits', 'vectorCount', 'lexicalCount'],
    properties: {
      hits: { type: 'array', items: Ref('RetrieveHit') },
      vectorCount: { type: 'integer' },
      lexicalCount: { type: 'integer' },
    },
  },
  HealthResponse: {
    type: 'object',
    required: ['status', 'services'],
    properties: {
      status: { type: 'string', enum: ['ok', 'degraded'] },
      services: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          required: ['ok', 'checks'],
          properties: {
            ok: { type: 'boolean' },
            checks: {
              type: 'object',
              additionalProperties: {
                type: 'object',
                required: ['ok'],
                properties: { ok: { type: 'boolean' }, detail: {} },
              },
            },
          },
        },
      },
    },
  },
}

const NormalizePath = (Path: string) => Path.replaceAll(/:([^/]+)/g, '{$1}').replace(/\/+$/, '') || '/'

function createDocRoute(Router: OpenAPIHono, ServerUrl: string) {
  const Document: any = Router.getOpenAPIDocument({ openapi: '3.1.0', info: Info })
  alignCrudOpenAPI(Document)

  for (const [Path, Item] of Object.entries(CustomPaths)) {
    const Key = Object.keys(Document.paths).find((Known) => NormalizePath(Known) === NormalizePath(Path)) ?? Path
    for (const Method of Object.keys(Item)) {
      if (Document.paths[Key]?.[Method]) {
        throw new Error(`OpenAPI 冲突：${Method.toUpperCase()} ${Path} 已由生成的文档注册`)
      }
    }
    Document.paths[Key] = { ...(Document.paths[Key] ?? {}), ...Item }
  }
  Document.components = {
    ...(Document.components ?? {}),
    schemas: { ...(Document.components?.schemas ?? {}), ...CustomSchemas },
  }
  Document.tags = Tags
  Document.servers = [{ url: ServerUrl }]

  return Scalar.serve({ document: Document, defaultOpenAllTags: true, theme: 'kepler' })
}
