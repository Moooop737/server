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
]

const Json = (Schema: object) => ({ 'application/json': { schema: Schema } })
const Ref = (Name: string) => ({ $ref: `#/components/schemas/${Name}` })
const Err = (Description: string) => ({ description: Description, content: Json(Ref('Error')) })
const Ok = (Description: string, Schema: object) => ({ description: Description, content: Json(Schema) })

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
      summary: '回收站：分页读取软删资源',
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000000 } },
        { name: 'per_page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
        { name: 'search', in: 'query', description: '按标题 / 来源搜索（最长 200 字）', schema: { type: 'string', maxLength: 200 } },
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
  '/observability/chats': {
    get: {
      tags: ['Observability'],
      operationId: 'listChatTraces',
      summary: '最近的 /chat 记录（本地库，可按会话过滤）',
      parameters: [
        { name: 'session_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
        { name: 'per_page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
      ],
      responses: {
        200: Ok('对话行与分页；不含 Langfuse 观测内容', {
          type: 'object',
          required: ['chats', 'pagination'],
          properties: {
            chats: { type: 'array', items: ChatTraceSchema },
            pagination: PageSchema,
          },
        }),
        400: Err('session_id 或分页参数不合法'),
        500: Err('读取对话列表失败'),
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
