# server

[English](README.md) | 简体中文

基于 Node.js 与 [Hono](https://hono.dev) 的本地优先 RAG（检索增强生成）后端：归档并入库文档，对其做混合检索（向量 + BM25），通过可调用工具的对话 Agent 回答问题，并记录观测与评测运行。

## 功能

- **资源**：上传文件（S3 预签名 PUT）、归档 URL 或粘贴文本，然后解析、切块、embed。支持软删、恢复、彻底删除，以及取消进行中的入库。
- **代码库**：上传 ZIP，浏览文件树，预览或下载单个文件。
- **检索**：`POST /retrieve` 同时跑向量检索（pgvector HNSW）与词法检索（ParadeDB BM25），用 RRF 融合。
- **问答**：`POST /chat` 以 UI message stream 流式返回答案，由模型自己决定是否调用检索工具。会话与消息存于 Postgres。
- **模型**：对话与 embedding 模型可来自 DeepSeek、DashScope（阿里云百炼）、Ollama、SiliconFlow（硅基流动）或任意 OpenAI 兼容端点，以 `provider:modelId` 指定。
- **观测**：每个请求的 trace 与阶段存于 Postgres，LLM 调用观测写入 Langfuse。
- **评测**：`/eval` 下的数据集、题目、配置与运行，可选使用独立评测库。
- **API 文档**：`/doc` 为 Scalar 参考页，原始 OpenAPI 在 `/doc/openapi.json`。

## 环境要求

- Node.js（需支持 `--env-file`）
- PostgreSQL，并装有 `vector`（pgvector）与 `pg_search`（ParadeDB）扩展
- [dbmate](https://github.com/amacneil/dbmate)，用于数据库迁移
- S3 兼容对象存储，例如 MinIO
- Ollama，或任一托管模型服务商的 API Key
- 可选：Langfuse，用于 LLM 观测

## 快速开始

```bash
npm install
# 创建 .env（见下方「配置」）
dbmate up          # 执行 db/migrations
npm run dev        # 监听模式；或 `npm start`
```

服务监听 `http://127.0.0.1:$PORT`（默认端口 `3000`）。打开 `/doc` 查看 API 文档，访问 `/health` 检查数据库、对象存储与模型服务是否可达。

## 配置

配置从 `.env` 读取。缺少必需项或取值非法时，服务在启动时以 `E_CONFIG_MISSING` 或 `E_CONFIG_INVALID` 退出。

| 变量 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DATABASE_URL` | 是 | | 主库 Postgres 连接串 |
| `OLLAMA_BASE_URL` | 是 | | Ollama 地址 |
| `EMBEDDING_MODEL` | 是 | | embedding 模型，`provider:modelId` |
| `CHAT_MODEL` | 是 | | 默认对话模型，`provider:modelId` |
| `S3_ENDPOINT` | 是 | | 对象存储地址，必须是浏览器访问时用的 Host（会被签进预签名 URL） |
| `S3_BUCKET` | 是 | | 桶名 |
| `S3_ACCESS_KEY_ID` | 是 | | Access Key |
| `S3_SECRET_ACCESS_KEY` | 是 | | Secret Key |
| `S3_REGION` | | `us-east-1` | 区域 |
| `S3_FORCE_PATH_STYLE` | | `true` | 路径风格寻址 |
| `PORT` | | `3000` | HTTP 端口（监听地址固定为 `127.0.0.1`） |
| `EMBEDDING_DIMENSIONS` | | `1024` | 向量维度；512、1024、2048 有 HNSW 索引 |
| `RETRIEVAL_VECTOR_TOPK` | | `10` | 向量检索候选数 |
| `RETRIEVAL_LEXICAL_TOPK` | | `10` | BM25 检索候选数 |
| `RETRIEVAL_MIN_SIMILARITY` | | `0.42` | 余弦相似度下限 |
| `RETRIEVAL_RRF_K` | | `60` | RRF 常数 |
| `RETRIEVAL_DEFAULT_LIMIT` | | `6` | 默认返回的融合结果条数 |
| `EVAL_DATABASE_URL` | | | 独立评测库；不设则评测与主库共享 |
| `DEEPSEEK_API_KEY`、`DASHSCOPE_API_KEY`、`SILICONFLOW_API_KEY`、`ROUTER1_API_KEY`、`ROUTER1_END_POINT` | | | 服务商凭据；缺 Key 的服务商不会注册 |
| `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY` | | | Langfuse 观测 |

## 脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 监听文件变化启动 |
| `npm start` | 启动 |
| `npm test` | 用 Vitest 跑测试 |
| `npm run test:ui` | Vitest UI |
| `npm run db:schema` | 从数据库重新生成 `src/adapter/repo/orm/schema.ts`（drizzle-kit introspect） |
| `npm run eval:db:setup` | 创建并迁移独立评测库 |
| `npm run eval:seed` | 把主库中 ready 的资源复制进评测库 |
| `npm run eval:cases:import` | 把 `scripts/eval-cases.json` 导入评测题集 |
| `npm run eval:probe` | 用样例问题跑检索并打印命中指标 |
| `npm run cleanup:test` | 清理测试数据 |

## 数据库

迁移文件位于 `db/migrations`，由 dbmate 执行，dbmate 是迁移的唯一真源。`drizzle.config.ts` 只供 `npm run db:schema` 使用：不要用它跑 `drizzle-kit generate` 或 `push`。

## 目录结构

```text
src/
  index.ts      入口与路由装配
  config.ts     环境变量读取与校验
  routes/       HTTP 路由
  adapter/      数据库、对象存储与模型服务商
  ingest/       抓取、解析、切块与 embed
  retrieve/     向量、词法与融合检索
  agent/        对话 Agent、提示词与工具
  resource/     资源生命周期
  codebase/     代码库 ZIP 归档与读取
  eval/         评测运行、指标与评审
  trace/        请求观测与 Langfuse
db/migrations/  dbmate 迁移
scripts/        维护与评测脚本
test/           测试
```
